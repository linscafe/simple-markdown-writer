import { syntaxTree } from "@codemirror/language";
import type { EditorState, Range } from "@codemirror/state";
import { Decoration, WidgetType } from "@codemirror/view";
import { isActive } from "./active";
import { inDisplayMath } from "./math-ranges";
import { statePreview, visibleLines, type SourceRange, type VisibleRange } from "./blocks";

export interface CodeBlock extends SourceRange {
  language: string;
  fences: SourceRange[];
}

export function findCodeBlocks(state: EditorState, visible: readonly VisibleRange[]): CodeBlock[] {
  const result = new Map<number, CodeBlock>();
  for (const range of visible) syntaxTree(state).iterate({
    ...range,
    enter(node) {
      if (node.name !== "FencedCode") return;
      if (inDisplayMath(state, node.from)) return false;
      const info = node.node.getChild("CodeInfo");
      result.set(node.from, {
        from: state.doc.lineAt(node.from).from, to: state.doc.lineAt(node.to).to,
        language: info ? state.sliceDoc(info.from, info.to).trim().split(/\s/)[0] : "",
        fences: node.node.getChildren("CodeMark").map((mark) => ({
          from: mark.from, to: state.doc.lineAt(mark.to).to,
        })),
      });
      return false;
    },
  });
  return [...result.values()];
}

class FenceWidget extends WidgetType {
  constructor(readonly language: string) { super(); }
  eq(other: FenceWidget): boolean { return this.language === other.language; }
  toDOM(): HTMLElement {
    const label = document.createElement("span");
    label.className = "cm-md-fence-label";
    label.textContent = this.language;
    return label;
  }
}

const preview = statePreview({
  find: findCodeBlocks,
  decorate(state, blocks, visible) {
    const ranges: Range<Decoration>[] = [];
    for (const block of blocks) {
      const active = isActive(state, block.from, block.to);
      const first = state.doc.lineAt(block.from).number;
      for (const number of visibleLines(state, visible)) {
        const line = state.doc.line(number);
        if (line.from < block.from || line.to > block.to) continue;
        const fence = block.fences.find((mark) => state.doc.lineAt(mark.from).number === number);
        ranges.push(Decoration.line({
          class: fence && !active ? "cm-md-codeblock cm-md-fence" : "cm-md-codeblock",
        }).range(line.from));
        if (fence && !active) ranges.push(Decoration.replace({
          widget: new FenceWidget(number === first ? block.language : ""),
        }).range(fence.from, fence.to));
      }
    }
    return Decoration.set(ranges, true);
  },
});

export const codeBlockPreview = preview.extension;
