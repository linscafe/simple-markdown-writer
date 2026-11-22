import { autocompletion, startCompletion, type CompletionContext, type CompletionResult, type CompletionSource } from "@codemirror/autocomplete";
import { syntaxTree } from "@codemirror/language";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { EditorState, type Extension } from "@codemirror/state";
import type { EditorContext } from "./extensions";
import { listDir, readFile } from "./fsapi";
import { headings, resolveDocumentPath } from "./navigate";

export interface PathCompletionContext {
  kind: "path" | "heading" | "wiki";
  from: number;
  dir: string;
  prefix: string;
  path: string;
}

export function completionContext(before: string): PathCompletionContext | null {
  const wiki = /\[\[([^\]\n|]*)$/.exec(before);
  const link = /\]\(([^\s()\n]*)$/.exec(before);
  const match = wiki ?? link;
  if (!match) return null;
  const value = match[1];
  const start = before.length - value.length;
  if (/^[a-z][\w+.-]*:|^\//i.test(value)) return null;
  const hash = value.indexOf("#");
  if (hash >= 0) {
    const path = value.slice(0, hash);
    if (path && !/\.md$/i.test(path)) return null;
    return { kind: "heading", from: start + hash + 1, dir: "", prefix: value.slice(hash + 1), path };
  }
  const slash = value.lastIndexOf("/");
  return { kind: wiki ? "wiki" : "path", from: start + slash + 1,
    dir: value.slice(0, slash + 1), prefix: value.slice(slash + 1), path: value };
}

function encodedName(name: string): string {
  return encodeURIComponent(name).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

export function pathCompletionSource(context: EditorContext): CompletionSource {
  return async (completion: CompletionContext): Promise<CompletionResult | null> => {
    let node = syntaxTree(completion.state).resolveInner(completion.pos, -1);
    for (;;) {
      if (["FencedCode", "CodeBlock", "InlineCode", "HTMLBlock"].includes(node.name)) return null;
      if (!node.parent) break;
      node = node.parent;
    }
    const line = completion.state.doc.lineAt(completion.pos);
    const detected = completionContext(completion.state.sliceDoc(line.from, completion.pos));
    if (!detected) return null;
    const from = line.from + detected.from;
    const docPath = context.path;
    try {
      if (detected.kind === "heading") {
        const targetState = detected.path
          ? EditorState.create({ doc: await readFile(resolveDocumentPath(context.dir, detected.path)), extensions: [markdown({ base: markdownLanguage })] })
          : completion.state;
        if (completion.aborted || context.path !== docPath) return null;
        return { from, options: headings(targetState).map((heading) => ({ label: heading.slug, detail: heading.text, type: "text" })), validFor: /^[\p{L}\p{N}\p{M}_%-]*$/u };
      }
      const entries = await listDir(docPath, detected.dir);
      if (completion.aborted || context.path !== docPath) return null;
      return {
        from,
        options: entries.filter((entry) => detected.kind !== "wiki" || (!entry.is_dir && /\.md$/i.test(entry.name)))
          .map((entry) => {
            const name = detected.kind === "wiki" ? entry.name.replace(/\.md$/i, "") : encodedName(entry.name);
            const label = name + (entry.is_dir ? "/" : "");
            return {
              label, displayLabel: entry.name + (entry.is_dir ? "/" : ""), type: entry.is_dir ? "namespace" : "file",
              apply: entry.is_dir ? (view, _option, start, end) => {
                view.dispatch({ changes: { from: start, to: end, insert: label }, selection: { anchor: start + label.length }, userEvent: "input.complete" });
                queueMicrotask(() => { startCompletion(view); });
              } : label,
            };
          }),
        validFor: detected.kind === "wiki" ? /^[^\]/#|]*$/ : /^[^\s()/#!]*$/,
      };
    } catch { return null; }
  };
}

export function pathCompletionExtension(context: EditorContext): Extension {
  return autocompletion({ override: [pathCompletionSource(context)] });
}
