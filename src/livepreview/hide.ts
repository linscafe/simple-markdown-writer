import { syntaxTree } from "@codemirror/language";
import { type EditorState, type Range } from "@codemirror/state";
import {
  Decoration, type DecorationSet, type EditorView, ViewPlugin, type ViewUpdate,
} from "@codemirror/view";
import { activeLines } from "./active";
import { activeTables } from "./tables";
import { previewViewport } from "./blocks";
import { mathItems } from "./math";
import { BulletWidget, CheckboxWidget, HorizontalRuleWidget } from "./widgets";
import "./preview.css";

export interface PreviewRange {
  from: number;
  to: number;
  kind: "hide" | "mark" | "line" | "bullet" | "checkbox" | "hr";
  className?: string;
  href?: string;
  checked?: boolean;
}

interface VisibleRange { from: number; to: number }

const untouched = new Set([
  "Image", "FencedCode", "CodeBlock", "Table", "HTMLBlock", "HTMLTag",
  "InlineMath", "BlockMath", "MathBlock",
]);

const inlineClasses: Record<string, string> = {
  Emphasis: "cm-md-em",
  StrongEmphasis: "cm-md-strong",
  Strikethrough: "cm-md-strike",
  InlineCode: "cm-md-code",
};

export function computePreview(state: EditorState, ranges: readonly VisibleRange[]): PreviewRange[] {
  const active = activeLines(state);
  const result: PreviewRange[] = [];
  const seen = new Set<string>();
  const tree = syntaxTree(state);
  const math = mathItems(state);
  const tables = activeTables(state);

  function add(range: PreviewRange): void {
    if (math.some(({ from, to }) => from <= range.from && range.from < to) ||
      tables.some(({ from, to }) => from <= range.from && range.from <= to)) return;
    const key = `${range.kind}:${range.from}:${range.to}:${range.className ?? ""}`;
    if (!seen.has(key)) {
      seen.add(key);
      result.push(range);
    }
  }

  for (const visible of ranges) {
    function inline(from: number, to: number, spec: Omit<PreviewRange, "from" | "to">): void {
      const end = Math.min(to, visible.to);
      let start = Math.max(from, visible.from);
      while (start < end) {
        const line = state.doc.lineAt(start);
        const stop = Math.min(end, line.to);
        if (start < stop && !active.has(line.number)) add({ from: start, to: stop, ...spec });
        start = line.to + 1;
      }
    }

    function lines(from: number, to: number, className: string): void {
      const end = Math.min(to, visible.to);
      let start = Math.max(from, visible.from);
      while (start <= end) {
        const line = state.doc.lineAt(start);
        if (!active.has(line.number)) add({ from: line.from, to: line.from, kind: "line", className });
        start = line.to + 1;
      }
    }

    function afterSpace(to: number): number {
      return state.sliceDoc(to, to + 1) === " " || state.sliceDoc(to, to + 1) === "\t" ? to + 1 : to;
    }

    tree.iterate({
      from: visible.from,
      to: visible.to,
      enter(ref) {
        if (untouched.has(ref.name)) return false;
        const node = ref.node;
        if (/^(ATX|Setext)Heading[1-6]$/.test(ref.name)) {
          const underline = ref.name.startsWith("Setext") ? node.getChild("HeaderMark") : null;
          lines(ref.from, underline ? state.doc.lineAt(underline.from).from - 1 : ref.to,
            `cm-h${ref.name.at(-1)}`);
          if (underline) inline(underline.from, underline.to, { kind: "mark", className: "cm-md-setext" });
        } else if (ref.name === "HeaderMark") {
          if (node.parent?.name.startsWith("ATX")) inline(ref.from, afterSpace(ref.to), { kind: "hide" });
        } else if (inlineClasses[ref.name]) {
          inline(ref.from, ref.to, { kind: "mark", className: inlineClasses[ref.name] });
        } else if (ref.name === "EmphasisMark" || ref.name === "StrikethroughMark" || ref.name === "CodeMark") {
          inline(ref.from, ref.to, { kind: "hide" });
        } else if (ref.name === "Link") {
          const marks = node.getChildren("LinkMark");
          const open = marks[0];
          const close = marks[1];
          // Reference links belong to the later link-resolution feature.
          if (open && close && marks.length >= 4) {
            const url = node.getChild("URL");
            const raw = url ? state.sliceDoc(url.from, url.to) : "";
            const href = raw.startsWith("<") && raw.endsWith(">") ? raw.slice(1, -1) : raw;
            inline(open.from, open.to, { kind: "hide" });
            inline(close.from, ref.to, { kind: "hide" });
            inline(open.to, close.from, { kind: "mark", className: "cm-md-link", href });
          }
        } else if (ref.name === "Autolink") {
          const url = node.getChild("URL");
          if (url) {
            inline(ref.from, url.from, { kind: "hide" });
            inline(url.to, ref.to, { kind: "hide" });
            const raw = state.sliceDoc(url.from, url.to);
            const href = raw.includes("@") && !raw.includes(":") ? `mailto:${raw}` : raw;
            inline(url.from, url.to, { kind: "mark", className: "cm-md-link", href });
          }
          return false;
        } else if (ref.name === "URL" && node.parent?.name !== "Link") {
          inline(ref.from, ref.to, {
            kind: "mark", className: "cm-md-link", href: state.sliceDoc(ref.from, ref.to),
          });
        } else if (ref.name === "Blockquote") {
          lines(ref.from, ref.to, "cm-md-quote");
        } else if (ref.name === "QuoteMark") {
          inline(ref.from, afterSpace(ref.to), { kind: "hide" });
        } else if (ref.name === "ListMark") {
          const task = node.parent?.getChild("Task")?.getChild("TaskMarker");
          if (task) inline(ref.from, afterSpace(ref.to), { kind: "hide" });
          else if (node.parent?.parent?.name === "BulletList") inline(ref.from, ref.to, { kind: "bullet" });
          else inline(ref.from, ref.to, { kind: "mark", className: "cm-md-list-number" });
        } else if (ref.name === "TaskMarker") {
          inline(ref.from, ref.to, { kind: "checkbox", checked: state.sliceDoc(ref.from + 1, ref.to - 1) !== " " });
        } else if (ref.name === "HorizontalRule") {
          inline(ref.from, ref.to, { kind: "hr" });
          return false;
        } else if (ref.name === "Escape") {
          inline(ref.from, ref.from + 1, { kind: "hide" });
        }
      },
    });
  }
  return result.sort((a, b) => a.from - b.from || a.to - b.to || a.kind.localeCompare(b.kind));
}

function decorations(view: EditorView): DecorationSet {
  const ranges: Range<Decoration>[] = computePreview(view.state, view.visibleRanges).map((range) => {
    let decoration: Decoration;
    switch (range.kind) {
      case "line": decoration = Decoration.line({ class: range.className }); break;
      case "mark": decoration = Decoration.mark({
        class: range.className,
        attributes: range.href === undefined ? undefined : { "data-href": range.href },
      }); break;
      case "bullet": decoration = Decoration.replace({ widget: new BulletWidget() }); break;
      case "checkbox": decoration = Decoration.replace({ widget: new CheckboxWidget(range.checked ?? false) }); break;
      case "hr": decoration = Decoration.replace({ widget: new HorizontalRuleWidget() }); break;
      case "hide": decoration = Decoration.replace({}); break;
    }
    return decoration.range(range.from, range.to);
  });
  return Decoration.set(ranges, true);
}

export const previewPlugin = ViewPlugin.fromClass(class {
  decorations: DecorationSet;

  constructor(view: EditorView) { this.decorations = decorations(view); }

  update(update: ViewUpdate): void {
    if (update.docChanged || update.selectionSet || update.viewportChanged ||
      update.transactions.some(transaction => transaction.effects.some(effect => effect.is(previewViewport))) ||
      syntaxTree(update.startState) !== syntaxTree(update.state)) {
      this.decorations = decorations(update.view);
    }
  }
}, { decorations: (plugin) => plugin.decorations });
