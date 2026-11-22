import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { EditorState, StateEffect, StateField, type ChangeSpec, type Extension } from "@codemirror/state";
import { EditorView, ViewPlugin, showPanel, type Panel, type ViewUpdate } from "@codemirror/view";
import { invoke } from "@tauri-apps/api/core";
import type { SyntaxNode, Tree } from "@lezer/common";
import type { EditorContext } from "./extensions";
import { isDirty, markSaved, showMessage } from "./document";
import { readFile, type InitialDoc } from "./fsapi";
import { headings, retargetHistory, slug, type Heading } from "./navigate";
import { registerEx } from "./vim";

const DEFAULT_IMAGE_DIR = "{name}.assets";

export function normalizePath(path: string): string {
  const slashed = path.replace(/\\/g, "/");
  const root = /^(?:[a-z]:)?\//i.exec(slashed)?.[0] ?? "";
  const parts: string[] = [];
  for (const part of slashed.slice(root.length).split("/")) {
    if (!part || part === ".") continue;
    if (part !== "..") parts.push(part);
    else if (parts.length && parts.at(-1) !== "..") parts.pop();
    else if (!root) parts.push("..");
  }
  return root + parts.join("/") || ".";
}

export function isAbsolute(path: string): boolean {
  return /^(?:[a-z]:)?[\\/]/i.test(path);
}

export function dirname(path: string): string {
  const normalized = normalizePath(path);
  const index = normalized.lastIndexOf("/");
  if (index < 0) return ".";
  const head = normalized.slice(0, index);
  return /^(?:[a-z]:)?$/i.test(head) ? `${head}/` : head;
}

export function basename(path: string): string {
  return normalizePath(path).split("/").pop() ?? "";
}

export function stem(path: string): string {
  return basename(path).replace(/(.)\.[^.]*$/, "$1");
}

export function joinPath(directory: string, path: string): string {
  return normalizePath(isAbsolute(path) ? path : `${directory}/${path}`);
}

export function relativePath(fromDirectory: string, to: string): string {
  const from = normalizePath(fromDirectory).split("/").filter(Boolean);
  const target = normalizePath(to).split("/").filter(Boolean);
  let common = 0;
  while (common < from.length && common < target.length && from[common] === target[common]) common++;
  return [...Array<string>(from.length - common).fill(".."), ...target.slice(common)].join("/") || ".";
}

export function targetPath(directory: string, input: string): string {
  const path = joinPath(directory, input.trim());
  return /\.[^./]+$/.test(basename(path)) ? path : `${path}.md`;
}

export function expandPattern(pattern: string, name: string): string {
  return pattern.replaceAll("{name}", name);
}

export type LinkKind = "link" | "image" | "reference" | "autolink" | "wiki" | "embed" | "html";

export interface LinkRef {
  kind: LinkKind;
  start: number;
  from: number;
  to: number;
  target: string;
  angle: boolean;
}

const literalNodes = new Set(["InlineCode", "FencedCode", "CodeBlock", "CodeText", "HTMLBlock", "HTMLTag", "Comment", "CommentBlock"]);
const linkNodes = new Set([...literalNodes, "Link", "Image", "Autolink", "URL", "LinkReference"]);
const urlParents: Record<string, LinkKind> = { Link: "link", Image: "image", LinkReference: "reference" };

function fullTree(state: EditorState): Tree {
  return ensureSyntaxTree(state, state.doc.length, 1000) ?? syntaxTree(state);
}

function within(tree: Tree, position: number, names: Set<string>): boolean {
  for (let node: SyntaxNode | null = tree.resolveInner(position, 1); node; node = node.parent) {
    if (names.has(node.name)) return true;
  }
  return false;
}

export function findLinkRefs(state: EditorState): LinkRef[] {
  const tree = fullTree(state);
  const refs: LinkRef[] = [];
  tree.iterate({ enter(node) {
    if (node.name === "HTMLTag" || node.name === "HTMLBlock") {
      const html = state.sliceDoc(node.from, node.to);
      for (const match of html.matchAll(/<[a-z][^>]*?\s(?:src|href)\s*=\s*(["'])(.*?)\1/gi)) {
        const from = node.from + match.index + match[0].length - 1 - match[2].length;
        refs.push({ kind: "html", start: from, from, to: from + match[2].length, target: match[2], angle: false });
      }
      return false;
    }
    if (literalNodes.has(node.name)) return false;
    if (node.name !== "URL") return;
    const parent = node.node.parent;
    const kind = parent ? urlParents[parent.name] : undefined;
    if (!parent || !kind) return;
    let { from, to } = node;
    const raw = state.sliceDoc(from, to);
    const angle = kind !== "autolink" && raw.startsWith("<") && raw.endsWith(">");
    if (angle) { from++; to--; }
    refs.push({ kind, start: parent.from, from, to, target: state.sliceDoc(from, to), angle: angle || kind === "autolink" });
  } });
  const text = state.doc.toString();
  for (const match of text.matchAll(/(!?)\[\[([^[\]\n]+)\]\]/g)) {
    if (text[match.index - 1] === "\\" || within(tree, match.index, literalNodes)) continue;
    const from = match.index + match[1].length + 2;
    const target = match[2].split("|")[0];
    refs.push({ kind: match[1] ? "embed" : "wiki", start: match.index, from, to: from + target.length, target, angle: true });
  }
  for (const match of text.matchAll(/<([^<>\s]+)>/g)) {
    const value = match[1];
    if (/^\/?[a-z][a-z\d-]*\/?$/i.test(value) || /^[a-z][a-z\d+.-]*:/i.test(value)) continue;
    if (value.includes("@") && !value.includes("/")) continue;
    if (within(tree, match.index, linkNodes)) continue;
    const from = match.index + 1;
    refs.push({ kind: "autolink", start: match.index, from, to: from + value.length, target: value, angle: true });
  }
  return refs.sort((a, b) => a.from - b.from);
}

const isWiki = (ref: LinkRef) => ref.kind === "wiki" || ref.kind === "embed";

function splitTarget(ref: LinkRef): { path: string; suffix: string } {
  const index = isWiki(ref) ? ref.target.indexOf("#") : ref.target.search(/[#?]/);
  return index < 0 ? { path: ref.target, suffix: "" } : { path: ref.target.slice(0, index), suffix: ref.target.slice(index) };
}

function decode(raw: string, ref: LinkRef): string {
  const unescaped = isWiki(ref) ? raw : raw.replace(/\\([!-/:-@[-`{-~])/g, "$1");
  try { return decodeURIComponent(unescaped); } catch { return unescaped; }
}

function isLocal(path: string): boolean {
  return !!path && !/^[a-z][a-z\d+.-]*:/i.test(path) && !path.startsWith("//");
}

function encodeSegment(segment: string, ref: LinkRef, percentStyle: boolean): string {
  if (ref.angle) return segment;
  const unsafe = percentStyle ? /[\x00-\x20()%#?[\]<>"`\\\x7f]/g : /[\x00-\x20()<>\x7f]/g;
  return segment.replace(unsafe, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`);
}

export interface DocumentMove {
  oldDir: string;
  newDir: string;
  assets?: { from: string; to: string };
}

export function rewriteTarget(ref: LinkRef, move: DocumentMove): string | null {
  const { path: rawPath, suffix } = splitTarget(ref);
  if (!isLocal(rawPath)) return null;
  const trailing = rawPath.endsWith("/") ? "/" : "";
  const raw = trailing ? rawPath.slice(0, -1) : rawPath;
  const decoded = decode(raw, ref);
  if (!decoded || isAbsolute(decoded)) return null;
  let target = joinPath(move.oldDir, decoded);
  let moved = false;
  if (move.assets) {
    const from = normalizePath(move.assets.from);
    if (target === from || target.startsWith(`${from}/`)) {
      target = normalizePath(move.assets.to) + target.slice(from.length);
      moved = true;
    }
  }
  if (!moved && normalizePath(move.oldDir) === normalizePath(move.newDir)) return null;
  const rawSegments = raw.split("/");
  const decodedSegments = rawSegments.map((segment) => decode(segment, ref));
  const segments = relativePath(move.newDir, target).split("/");
  let tail = 0;
  while (tail < rawSegments.length && tail < segments.length) {
    const original = decodedSegments[decodedSegments.length - 1 - tail];
    if (original === "." || original === ".." || original !== segments[segments.length - 1 - tail]) break;
    tail++;
  }
  const percentStyle = /%[\da-f]{2}/i.test(raw);
  const head = segments.slice(0, segments.length - tail)
    .map((segment) => segment === ".." ? segment : encodeSegment(segment, ref, percentStyle));
  const result = [...head, ...rawSegments.slice(rawSegments.length - tail)].join("/") + trailing + suffix;
  return result === ref.target ? null : result;
}

export function rewriteLinks(state: EditorState, move: DocumentMove): ChangeSpec[] {
  return findLinkRefs(state).flatMap((ref) => {
    const insert = rewriteTarget(ref, move);
    return insert === null ? [] : [{ from: ref.from, to: ref.to, insert }];
  });
}

export interface AssetPlan { from: string; to: string; fromLabel: string; toLabel: string }

export function assetPlan(oldPath: string, newPath: string, pattern = DEFAULT_IMAGE_DIR): AssetPlan | null {
  if (!pattern.includes("{name}")) return null;
  const oldDir = dirname(oldPath);
  const from = joinPath(oldDir, expandPattern(pattern, stem(oldPath)));
  const to = joinPath(dirname(newPath), expandPattern(pattern, stem(newPath)));
  if (from === to) return null;
  return { from, to, fromLabel: relativePath(oldDir, from), toLabel: relativePath(oldDir, to) };
}

function candidatePaths(ref: LinkRef, decoded: string, docPath: string): string[] {
  const directory = dirname(docPath);
  const base = joinPath(directory, decoded);
  if (ref.kind === "embed") return [base, joinPath(directory, `${stem(docPath)}.assets/${decoded}`)];
  if (ref.kind === "wiki" && !/\.md$/i.test(decoded)) return [`${base}.md`, base];
  return [base];
}

export function orphanFiles(state: EditorState, docPath: string, assetDir: string, files: string[]): string[] {
  const referenced = new Set<string>();
  for (const ref of findLinkRefs(state)) {
    const { path } = splitTarget(ref);
    if (!isLocal(path)) continue;
    for (const candidate of candidatePaths(ref, decode(path, ref), docPath)) referenced.add(candidate);
  }
  return files.filter((file) => !referenced.has(joinPath(assetDir, file)));
}

export interface LinkCheck {
  ref: LinkRef;
  line: number;
  column: number;
  paths: string[];
  anchor: string;
  markdown: boolean;
}

export function brokenCandidates(state: EditorState, docPath: string): LinkCheck[] {
  const checks: LinkCheck[] = [];
  for (const ref of findLinkRefs(state)) {
    const { path, suffix } = splitTarget(ref);
    const anchor = suffix.startsWith("#") ? decode(suffix.slice(1), ref) : "";
    if (path ? !isLocal(path) : !anchor) continue;
    const decoded = decode(path, ref);
    const line = state.doc.lineAt(ref.start);
    checks.push({
      ref, line: line.number, column: ref.start - line.from + 1, anchor,
      paths: path ? candidatePaths(ref, decoded, docPath) : [],
      markdown: ref.kind === "wiki" || /\.md$/i.test(decoded),
    });
  }
  return checks;
}

export interface BrokenLink { pos: number; line: number; column: number; target: string; reason: string }

export interface BrokenLinkIO {
  exists(paths: string[]): Promise<boolean[]>;
  read(path: string): Promise<string>;
}

function hasAnchor(list: Heading[], anchor: string): boolean {
  const normalized = slug(anchor);
  return list.some((heading) => heading.slug === anchor || heading.slug === normalized || heading.text === anchor);
}

export async function findBroken(state: EditorState, docPath: string, io: BrokenLinkIO): Promise<BrokenLink[]> {
  const checks = brokenCandidates(state, docPath);
  const unique = [...new Set(checks.flatMap((check) => check.paths))];
  const found = unique.length ? await io.exists(unique) : [];
  const existing = new Set(unique.filter((_, index) => found[index]));
  const current = normalizePath(docPath);
  const cache = new Map<string, Heading[] | null>([[current, headings(state)]]);
  const headingsOf = async (path: string): Promise<Heading[] | null> => {
    if (!cache.has(path)) {
      try {
        const doc = await io.read(path);
        cache.set(path, headings(EditorState.create({ doc, extensions: markdown({ base: markdownLanguage }) })));
      } catch {
        cache.set(path, null);
      }
    }
    return cache.get(path) ?? null;
  };
  const broken: BrokenLink[] = [];
  for (const check of checks) {
    const report = (reason: string) => broken.push({
      pos: check.ref.start, line: check.line, column: check.column, target: check.ref.target, reason,
    });
    const path = check.paths.length ? check.paths.find((candidate) => existing.has(candidate)) : current;
    if (!path) { report("missing file"); continue; }
    if (!check.anchor || (path !== current && !check.markdown)) continue;
    const list = await headingsOf(path);
    if (list && !hasAnchor(list, check.anchor)) report("missing heading");
  }
  return broken;
}

export function askYesNo(view: EditorView, question: string): Promise<boolean> {
  view.dispatch({ effects: showMessage.of(question) });
  return new Promise((resolve) => {
    const handler = (event: KeyboardEvent) => {
      if (["Shift", "Control", "Alt", "Meta", "CapsLock", "AltGraph"].includes(event.key)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      window.removeEventListener("keydown", handler, true);
      view.dispatch({ effects: showMessage.of("") });
      resolve(event.key === "y" || event.key === "Y" || event.key === "Enter");
    };
    window.addEventListener("keydown", handler, true);
  });
}

interface PanelRow { label: string; pos?: number; path?: string }
interface PanelSpec { title: string; rows: PanelRow[]; action: "jump" | "delete" | "list" }

const setPanel = StateEffect.define<PanelSpec | null>();
const panelField = StateField.define<PanelSpec | null>({
  create: () => null,
  update: (spec, transaction) => {
    for (const effect of transaction.effects) if (effect.is(setPanel)) spec = effect.value;
    return spec;
  },
  provide: (field) => showPanel.from(field, (spec) => spec ? housekeepingPanel : null),
});

const contexts = new WeakMap<EditorView, EditorContext>();
let busy = false;

function message(view: EditorView, text: string): void {
  if (contexts.has(view)) view.dispatch({ effects: showMessage.of(text) });
}

const pathsExist = (paths: string[]) => invoke<boolean[]>("paths_exist", { paths });

async function deleteRows(view: EditorView, rows: PanelRow[]): Promise<void> {
  const what = rows.length === 1 ? rows[0].label : `${rows.length} files`;
  if (!await askYesNo(view, `Delete ${what}? (y/n)`)) return;
  const paths = rows.flatMap((row) => row.path ? [row.path] : []);
  try {
    await invoke("delete_files", { paths });
    message(view, `Deleted ${what}`);
  } catch (error) {
    message(view, String(error));
  }
  const remaining = await pathsExist(paths);
  const deleted = new Set(paths.filter((_, index) => !remaining[index]));
  const spec = view.state.field(panelField, false);
  if (!spec) return;
  const rest = spec.rows.filter((row) => !row.path || !deleted.has(row.path));
  view.dispatch({ effects: setPanel.of(rest.length ? { ...spec, rows: rest } : null) });
  if (!rest.length) view.focus();
}

function exclusive(view: EditorView, task: () => Promise<void>): void {
  if (busy) { message(view, "Another file operation is in progress"); return; }
  busy = true;
  void task().catch((error: unknown) => message(view, String(error))).finally(() => { busy = false; });
}

function housekeepingPanel(view: EditorView): Panel {
  const dom = document.createElement("div");
  dom.className = "mdw-housekeeping";
  dom.tabIndex = 0;
  const title = document.createElement("div");
  title.className = "mdw-housekeeping-title";
  const list = document.createElement("ul");
  list.setAttribute("role", "listbox");
  dom.append(title, list);
  let spec = view.state.field(panelField) ?? { title: "", rows: [], action: "jump" };
  let selected = 0;

  const close = () => {
    view.dispatch({ effects: setPanel.of(null) });
    view.focus();
  };
  const activate = () => {
    const row = spec.rows[selected];
    if (spec.action !== "jump" || row?.pos === undefined) return;
    view.dispatch({
      selection: { anchor: Math.min(row.pos, view.state.doc.length) },
      scrollIntoView: true, effects: setPanel.of(null),
    });
    view.focus();
  };
  const render = () => {
    const hint = { jump: "Enter: go, ", delete: "d: delete, ", list: "" }[spec.action];
    title.textContent = `${spec.title} — j/k: move, ${hint}q/Esc: close`;
    list.replaceChildren(...spec.rows.map((row, index) => {
      const item = document.createElement("li");
      item.textContent = row.label;
      item.setAttribute("role", "option");
      item.setAttribute("aria-selected", String(index === selected));
      if (index === selected) item.className = "mdw-selected";
      item.addEventListener("click", () => { selected = index; render(); });
      item.addEventListener("dblclick", activate);
      return item;
    }));
    list.children[selected]?.scrollIntoView?.({ block: "nearest" });
  };
  dom.addEventListener("keydown", (event) => {
    if (event.ctrlKey || event.altKey || event.metaKey) return;
    switch (event.key) {
      case "j": case "ArrowDown": selected = Math.min(selected + 1, spec.rows.length - 1); render(); break;
      case "k": case "ArrowUp": selected = Math.max(selected - 1, 0); render(); break;
      case "q": case "Escape": close(); break;
      case "Enter": activate(); break;
      case "d": {
        const row = spec.rows[selected];
        if (spec.action === "delete" && row) exclusive(view, () => deleteRows(view, [row]));
        break;
      }
      default: return;
    }
    event.preventDefault();
    event.stopPropagation();
  });
  render();
  return {
    dom,
    mount: () => dom.focus(),
    update: (update: ViewUpdate) => {
      const next = update.state.field(panelField);
      if (!next || next === spec) return;
      spec = next;
      selected = Math.max(0, Math.min(selected, spec.rows.length - 1));
      render();
    },
  };
}

async function relocate(view: EditorView, context: EditorContext, copy: boolean, overwrite: boolean, input: string): Promise<void> {
  if (!input) { message(view, `Usage: :${copy ? "saveas" : "rename"}[!] <newpath>`); return; }
  if (!context.adoptDocument) { message(view, "Renaming is not available"); return; }
  const previousPath = context.path;
  const oldPath = normalizePath(context.path);
  const oldDir = dirname(oldPath);
  const newPath = targetPath(oldDir, input);
  const plan = assetPlan(oldPath, newPath, context.config?.image_dir);
  let assets: AssetPlan | undefined;
  if (plan) {
    const [exists] = await pathsExist([plan.from]);
    const question = `${copy ? "Copy" : "Rename"} ${plan.fromLabel}/ → ${plan.toLabel}/ and update links? (y/n)`;
    if (exists && await askYesNo(view, question)) assets = plan;
  }
  const snapshot = view.state.doc;
  const changes = view.state.changes(rewriteLinks(view.state, { oldDir, newDir: dirname(newPath), assets }));
  const next = changes.apply(snapshot);
  const content = copy || isDirty(view.state) || !changes.empty ? next.toString() : null;
  const doc = await invoke<InitialDoc>("rename_document", { request: {
    from: oldPath, to: newPath, overwrite, copy, content,
    assets: assets ? { from: assets.from, to: assets.to } : null,
  } });
  await context.adoptDocument(doc.path);
  if (!copy) retargetHistory(view, previousPath, doc.path);
  const done = `${copy ? "Saved as" : "Renamed to"} ${basename(doc.path)}`;
  if (view.state.doc === snapshot) view.dispatch({ changes, effects: [markSaved.of(next), showMessage.of(done)] });
  else message(view, `${done}; edits made meanwhile are unsaved`);
}

async function orphans(view: EditorView, context: EditorContext, deleteAll: boolean): Promise<void> {
  const pattern = context.config?.image_dir ?? DEFAULT_IMAGE_DIR;
  const assetDir = joinPath(dirname(context.path), expandPattern(pattern, stem(context.path)));
  const files = await invoke<string[] | null>("list_files", { dir: assetDir });
  if (!files) { message(view, "No asset directory"); return; }
  const rows = orphanFiles(view.state, context.path, assetDir, files).map((file) => {
    const path = joinPath(assetDir, file);
    return { label: relativePath(dirname(context.path), path), path };
  });
  if (!rows.length) { message(view, "No orphaned files"); return; }
  const shared = !pattern.includes("{name}");
  if (deleteAll && shared) { message(view, "Asset directory is shared with other documents; not deleting"); return; }
  if (deleteAll) { await deleteRows(view, rows); return; }
  const title = `Orphaned files (${rows.length}${shared ? "; shared directory, other documents may use these" : ""})`;
  view.dispatch({ effects: [setPanel.of({ title, rows, action: shared ? "list" : "delete" }), showMessage.of("")] });
}

async function broken(view: EditorView, context: EditorContext): Promise<void> {
  const found = await findBroken(view.state, context.path, { exists: pathsExist, read: readFile });
  if (!found.length) { message(view, "No broken links"); return; }
  const rows = found.map((link) => ({ label: `${link.line}:${link.column}  ${link.target}  (${link.reason})`, pos: link.pos }));
  view.dispatch({ effects: [setPanel.of({ title: `Broken links (${rows.length})`, rows, action: "jump" }), showMessage.of("")] });
}

type Task = (view: EditorView, context: EditorContext, bang: boolean, argument: string) => Promise<void>;

function exCommand(task: Task): Parameters<typeof registerEx>[2] {
  return (cm, params) => {
    const view = cm.cm6 as EditorView;
    const context = contexts.get(view);
    if (!context) return;
    const [, bang = "", argument = ""] = /^\s*(!?)\s*(.*?)\s*$/.exec(params.argString ?? "") ?? [];
    exclusive(view, () => task(view, context, bang === "!", argument));
  };
}

registerEx("rename", "ren", exCommand((view, context, bang, argument) => relocate(view, context, false, bang, argument)));
registerEx("saveas", "sav", exCommand((view, context, bang, argument) => relocate(view, context, true, bang, argument)));
registerEx("orphans", "orph", exCommand((view, context, bang) => orphans(view, context, bang)));
registerEx("broken", "bro", exCommand((view, context) => broken(view, context)));

export function housekeepingExtension(context: EditorContext): Extension {
  return [
    panelField,
    ViewPlugin.define((view) => {
      contexts.set(view, context);
      return { destroy: () => { contexts.delete(view); } };
    }),
    EditorView.baseTheme({
      ".mdw-housekeeping": {
        maxHeight: "40vh", overflow: "auto", padding: "4px 0", outline: "none",
        color: "var(--fg)", background: "var(--bg)", borderTop: "1px solid var(--muted)",
        fontFamily: "var(--font-mono)", fontSize: "13px",
      },
      ".mdw-housekeeping-title": { padding: "2px 16px", color: "var(--muted)" },
      ".mdw-housekeeping ul": { listStyle: "none", margin: "0", padding: "0" },
      ".mdw-housekeeping li": { padding: "1px 16px", whiteSpace: "pre", cursor: "pointer" },
      ".mdw-housekeeping li.mdw-selected": { background: "var(--selection)" },
    }),
  ];
}
