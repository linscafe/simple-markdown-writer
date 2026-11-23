import { Compartment, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { HighlightStyle, LanguageDescription, syntaxHighlighting } from "@codemirror/language";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { tags } from "@lezer/highlight";
import { livePreview } from "./livepreview";
import type { EditorContext } from "./extensions";

const modeCompartment = new Compartment();
const markdownSupport = markdown({ base: markdownLanguage, codeLanguages: languages });
const sourceClass = EditorView.editorAttributes.of({ class: "mdw-source" });
const markdownSourceHighlight = syntaxHighlighting(HighlightStyle.define([
  { tag: tags.heading, fontWeight: "bold", color: "var(--accent)" },
  { tag: tags.emphasis, fontStyle: "italic" },
  { tag: tags.strong, fontWeight: "bold" },
  { tag: tags.strikethrough, textDecoration: "line-through" },
  { tag: [tags.link, tags.url], color: "var(--link, var(--accent))" },
  { tag: [tags.processingInstruction, tags.contentSeparator, tags.labelName, tags.quote], color: "var(--muted)" },
  { tag: tags.monospace, color: "var(--code-fg)" },
]));

type ModeContext = Pick<EditorContext, "path" | "dir" | "sourceView">;

export function isMarkdownPath(path: string): boolean {
  const name = path.split(/[\\/]/).pop() ?? "";
  return !/\.[^.]+$/.test(name) || /\.(md|markdown|mdown|mkd|mdx)$/i.test(name);
}

function modeFor(context: ModeContext): Extension {
  if (!isMarkdownPath(context.path)) return sourceClass;
  return context.sourceView ? [markdownSupport, markdownSourceHighlight, sourceClass] : [markdownSupport, livePreview(context)];
}

/** Markdown with live preview, Markdown source, or another file's own language. */
export function modeExtension(context: ModeContext): Extension {
  return modeCompartment.of(modeFor(context));
}

/** Re-applies the mode after the document path or the source-view setting changed. */
export function refreshMode(view: EditorView, context: ModeContext): void {
  view.dispatch({ effects: modeCompartment.reconfigure(modeFor(context)) });
  if (isMarkdownPath(context.path)) return;
  const description = LanguageDescription.matchFilename(languages, context.path.split(/[\\/]/).pop() ?? "");
  if (!description) return;
  const path = context.path;
  description.load().then((support) => {
    if (context.path === path) view.dispatch({ effects: modeCompartment.reconfigure([support, sourceClass]) });
  }).catch(console.error);
}

export function setSourceView(view: EditorView, context: ModeContext, source: boolean): void {
  context.sourceView = source;
  refreshMode(view, context);
}
