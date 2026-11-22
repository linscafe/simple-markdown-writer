import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import { Prec, type EditorState, type Extension } from "@codemirror/state";
import { EditorView, ViewPlugin, keymap } from "@codemirror/view";
import { getCM, Vim } from "@replit/codemirror-vim";
import type { SyntaxNode } from "@lezer/common";
import type { EditorContext } from "./extensions";
import { isDirty, showMessage } from "./document";
import { openExternal } from "./fsapi";

export type LinkTarget =
  | { kind: "external"; url: string }
  | { kind: "anchor"; anchor: string }
  | { kind: "markdown" | "wikilink" | "file"; path: string; anchor: string };

export function classifyLink(raw: string): LinkTarget {
  const wiki = raw.startsWith("[[") && raw.endsWith("]]");
  const value = wiki ? raw.slice(2, -2).split("|")[0] : raw.replace(/^<|>$/g, "");
  if (/^(https?:|mailto:)/i.test(value)) return { kind: "external", url: value };
  const hash = value.indexOf("#");
  const path = hash < 0 ? value : value.slice(0, hash);
  const anchor = hash < 0 ? "" : value.slice(hash + 1);
  if (!path && hash === 0) return { kind: "anchor", anchor };
  if (wiki) return { kind: "wikilink", path: /\.md$/i.test(path) ? path : `${path}.md`, anchor };
  return { kind: /\.md$/i.test(path) && !/^(?:[a-z][\w+.-]*:|\/)/i.test(path) ? "markdown" : "file", path, anchor };
}

export function slug(text: string, used?: Set<string>): string {
  const base = text.toLowerCase().replace(/[^\p{L}\p{N}\p{M}_\-\s]/gu, "").replace(/\s/g, "-");
  let result = base;
  for (let suffix = 1; used?.has(result); suffix++) result = `${base}-${suffix}`;
  used?.add(result);
  return result;
}

export interface Heading { text: string; slug: string; from: number }

function headingText(state: EditorState, node: SyntaxNode): string {
  if (["HeaderMark", "EmphasisMark", "StrikethroughMark", "CodeMark", "LinkMark", "URL", "LinkTitle"].includes(node.name)) return "";
  if (node.name === "Escape") return state.sliceDoc(node.from + 1, node.to);
  if (!node.firstChild) return state.sliceDoc(node.from, node.to);
  let result = "";
  let position = node.from;
  for (let child: SyntaxNode | null = node.firstChild; child; child = child.nextSibling) {
    result += state.sliceDoc(position, child.from) + headingText(state, child);
    position = child.to;
  }
  return result + state.sliceDoc(position, node.to);
}

export function headings(state: EditorState): Heading[] {
  const result: Heading[] = [];
  const used = new Set<string>();
  const tree = ensureSyntaxTree(state, state.doc.length, 100) ?? syntaxTree(state);
  tree.iterate({ enter(ref) {
    if (!/^(ATX|Setext)Heading[1-6]$/.test(ref.name)) return;
    const text = headingText(state, ref.node).trim();
    result.push({ text, slug: slug(text, used), from: ref.from });
    return false;
  } });
  return result;
}

export function resolveDocumentPath(directory: string, relative: string): string {
  const decoded = decodeURIComponent(relative).replace(/\\/g, "/");
  const base = directory.replace(/\\/g, "/");
  const joined = /^(?:\/|[a-z]:\/)/i.test(decoded) ? decoded : `${base}/${decoded}`;
  const parts: string[] = [];
  for (const part of joined.split("/")) {
    if (part === ".") continue;
    if (part === ".." && parts.length > 1) parts.pop();
    else if (part !== "..") parts.push(part);
  }
  return parts.join("/");
}

export function linkAt(state: EditorState, position: number): string | null {
  const line = state.doc.lineAt(position);
  let node: SyntaxNode | null = syntaxTree(state).resolveInner(position, 1);
  let link: SyntaxNode | null = null;
  while (node) {
    if (["FencedCode", "CodeBlock", "InlineCode", "HTMLBlock"].includes(node.name)) return null;
    if (["Link", "Autolink", "URL"].includes(node.name)) link = node;
    node = node.parent;
  }
  if (link) {
    const url = link.name === "URL" ? link : link.getChild("URL");
    if (url) {
      const raw = state.sliceDoc(url.from, url.to).replace(/^<|>$/g, "");
      return link.name === "Autolink" && !raw.includes(":") && raw.includes("@") ? `mailto:${raw}` : raw;
    }
  }
  for (const match of line.text.matchAll(/\[\[[^\]\n]+\]\]/g)) {
    const from = line.from + match.index;
    if (from <= position && position < from + match[0].length) return match[0];
  }
  return null;
}

interface Location { path: string; cursor: number }
interface Navigation {
  follow(target: string): Promise<void>;
  go(direction: -1 | 1): Promise<void>;
  retarget(from: string, to: string): void;
}
const navigators = new WeakMap<EditorView, Navigation>();

export function retargetHistory(view: EditorView, from: string, to: string): void {
  navigators.get(view)?.retarget(from, to);
}

Vim.defineAction("mdwFollowLink", (cm) => {
  const view = cm.cm6 as EditorView;
  const target = linkAt(view.state, view.state.selection.main.head);
  if (target) void navigators.get(view)?.follow(target);
});
Vim.mapCommand("gx", "action", "mdwFollowLink", {}, { context: "normal" });
for (const [keys, direction] of [["<C-o>", -1], ["<C-i>", 1]] as const) {
  Vim.defineAction(`mdwHistory${direction}`, (cm) => { void navigators.get(cm.cm6 as EditorView)?.go(direction); });
  Vim.mapCommand(keys, "action", `mdwHistory${direction}`, {}, { context: "normal" });
}

export function navigationExtension(context: EditorContext): Extension {
  const back: Location[] = [];
  const forward: Location[] = [];
  let busy = false;
  const location = (view: EditorView): Location => ({ path: context.path, cursor: view.state.selection.main.head });
  const message = (view: EditorView, text: string) => view.dispatch({ effects: showMessage.of(text) });
  const move = async (view: EditorView, to: Location): Promise<boolean> => {
    if (to.path !== context.path) return await context.openDocument?.(to.path, to.cursor) ?? false;
    view.dispatch({ selection: { anchor: Math.min(to.cursor, view.state.doc.length) }, scrollIntoView: true });
    return true;
  };
  const navigation = (view: EditorView): Navigation => ({
    async follow(raw) {
      if (busy) return;
      busy = true;
      try {
        const target = classifyLink(raw);
        if (target.kind === "external") { await openExternal(target.url); return; }
        if (target.kind === "file") { message(view, `Cannot open this link: ${target.path}`); return; }
        const previous = location(view);
        let changed = false;
        if (target.kind !== "anchor") {
          if (isDirty(view.state)) { message(view, "Unsaved changes. Use :w to save before opening another document."); return; }
          const path = resolveDocumentPath(context.dir, target.path);
          if (path !== context.path) {
            if (!await context.openDocument?.(path)) return;
            changed = true;
          }
        }
        if (target.anchor || target.kind === "anchor") {
          const anchor = decodeURIComponent(target.anchor);
          const heading = headings(view.state).find((entry) => entry.slug === anchor);
          if (heading) {
            view.dispatch({ selection: { anchor: heading.from }, scrollIntoView: true });
            changed = true;
          } else message(view, `Heading not found: #${anchor}`);
        }
        if (changed) { back.push(previous); forward.length = 0; }
      } catch (error) {
        message(view, `Cannot follow link: ${String(error)}`);
      } finally { busy = false; }
    },
    retarget(from, to) {
      for (const entry of [...back, ...forward]) if (entry.path === from) entry.path = to;
    },
    async go(direction) {
      if (busy) return;
      const source = direction < 0 ? back : forward;
      const destination = direction < 0 ? forward : back;
      const target = source.at(-1);
      if (!target) return;
      busy = true;
      try {
        const previous = location(view);
        if (await move(view, target)) { source.pop(); destination.push(previous); }
      } catch (error) { message(view, `Cannot navigate: ${String(error)}`); }
      finally { busy = false; }
    },
  });
  return [
    ViewPlugin.define((view) => {
      navigators.set(view, navigation(view));
      return { destroy: () => { navigators.delete(view); } };
    }),
    EditorView.domEventHandlers({
      click(event, view) {
        if (!event.ctrlKey && !event.metaKey) return false;
        const rendered = event.target instanceof Element ? event.target.closest<HTMLElement>(".cm-md-link[data-href]") : null;
        const position = rendered ? null : view.posAtCoords({ x: event.clientX, y: event.clientY });
        const target = rendered?.dataset.href ?? (position === null ? null : linkAt(view.state, position));
        if (!target) return false;
        event.preventDefault();
        void navigators.get(view)?.follow(target);
        return true;
      },
    }),
    Prec.highest(keymap.of([
      ...([-1, 1] as const).map((direction) => ({
        key: direction < 0 ? "Alt-ArrowLeft" : "Alt-ArrowRight",
        run: (view: EditorView) => { void navigators.get(view)?.go(direction); return true; },
      })),
      ...([-1, 1] as const).map((direction) => ({
        key: direction < 0 ? "Ctrl-o" : "Ctrl-i",
        run: (view: EditorView) => {
          const vim = getCM(view)?.state.vim;
          if (!vim || vim.insertMode || vim.visualMode) return false;
          void navigators.get(view)?.go(direction);
          return true;
        },
      })),
    ])),
  ];
}
