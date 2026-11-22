import { syntaxTree } from "@codemirror/language";
import { EditorSelection, EditorState, Facet, StateEffect, StateField, type Extension, type StateEffectType } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { isActive } from "./active";

export interface VisibleRange { from: number; to: number }
export interface SourceRange { from: number; to: number }

export function touchesVisible(from: number, to: number, visible: readonly VisibleRange[]): boolean {
  return visible.some(range => from <= range.to && to >= range.from);
}

export const previewViewport = StateEffect.define<readonly VisibleRange[]>();
const previewDecorations = Facet.define<DecorationSet>();

function sameRanges(a: readonly VisibleRange[], b: readonly VisibleRange[]): boolean {
  return a.length === b.length && a.every((range, i) => range.from === b[i].from && range.to === b[i].to);
}

const viewportTracker = ViewPlugin.fromClass(class {
  private queued = false;
  private destroyed = false;

  constructor(private view: EditorView) { this.schedule(); }

  update(update: ViewUpdate): void {
    if (update.docChanged || update.viewportChanged ||
      syntaxTree(update.startState) !== syntaxTree(update.state)) this.schedule();
  }

  private schedule(): void {
    if (this.queued) return;
    this.queued = true;
    queueMicrotask(() => {
      this.queued = false;
      if (this.destroyed) return;
      const ranges = [...this.view.visibleRanges];
      const viewport = this.view.viewport;
      // CodeMirror omits large replacements from visibleRanges. Their widgets
      // are still on screen, so keep their source in the next preview pass.
      for (const set of this.view.state.facet(previewDecorations)) {
        set.between(viewport.from, viewport.to, (from, to, decoration) => {
          if (from < to && decoration.spec.widget) {
            ranges.push({ from: Math.max(from, viewport.from), to: Math.min(to, viewport.to) });
          }
        });
      }
      const merged: VisibleRange[] = [];
      for (const range of ranges.sort((a, b) => a.from - b.from)) {
        const previous = merged.at(-1);
        if (previous && range.from <= previous.to) previous.to = Math.max(previous.to, range.to);
        else merged.push({ ...range });
      }
      this.view.dispatch({ effects: previewViewport.of(merged) });
    });
  }

  destroy(): void { this.destroyed = true; }
});

interface PreviewState<T> {
  visible: readonly VisibleRange[];
  items: readonly T[];
  active: string;
  decorations: DecorationSet;
  tree: ReturnType<typeof syntaxTree>;
}

export function statePreview<T extends SourceRange>(options: {
  find(state: EditorState, visible: readonly VisibleRange[]): readonly T[];
  decorate(state: EditorState, items: readonly T[], visible: readonly VisibleRange[]): DecorationSet;
  refresh?: StateEffectType<null>;
}): { extension: Extension; field: StateField<PreviewState<T>> } {
  const field = StateField.define<PreviewState<T>>({
    create: (state) => ({ visible: [], items: [], active: "", decorations: Decoration.none, tree: syntaxTree(state) }),
    update(value, transaction) {
      let visible = transaction.docChanged ? value.visible.map(({ from, to }) => ({
        from: transaction.changes.mapPos(from, -1), to: transaction.changes.mapPos(to, 1),
      })) : value.visible;
      const state = transaction.state;
      const tree = syntaxTree(state);
      let rebuild = transaction.docChanged || tree !== value.tree;
      let redraw = false;
      for (const effect of transaction.effects) {
        if (effect.is(previewViewport)) {
          visible = effect.value;
          rebuild ||= !sameRanges(visible, value.visible);
        } else if (options.refresh && effect.is(options.refresh)) redraw = true;
      }
      if (!rebuild && !redraw && !transaction.selection) return value;
      const items = rebuild ? options.find(state, visible) : value.items;
      const active = items.map(({ from, to }) => isActive(state, from, to) ? "1" : "0").join("");
      if (!rebuild && !redraw && active === value.active) return value;
      return { visible, items, active, tree, decorations: options.decorate(state, items, visible) };
    },
    provide: (field) => [
      EditorView.decorations.from(field, (value) => value.decorations),
      previewDecorations.from(field, (value) => value.decorations),
    ],
  });
  return { extension: [field, viewportTracker], field };
}

// Vertical motion jumps over block widgets; a one-line step across an inactive block lands inside it instead.
export function enterSkippedBlocks<T extends SourceRange>(
  field: StateField<PreviewState<T>>, isBlock: (item: T) => boolean = () => true,
): Extension {
  return EditorState.transactionFilter.of((transaction) => {
    const before = transaction.startState.selection.main, after = transaction.selection?.main;
    if (transaction.docChanged || !after || !before.empty || !after.empty) return transaction;
    const doc = transaction.startState.doc;
    const from = doc.lineAt(before.head).number, to = doc.lineAt(after.head).number;
    if (Math.abs(to - from) < 2) return transaction;
    for (const item of transaction.startState.field(field, false)?.items ?? []) {
      if (!isBlock(item) || isActive(transaction.startState, item.from, item.to)) continue;
      const first = doc.lineAt(item.from).number, last = doc.lineAt(item.to).number;
      const target = from === first - 1 && to === last + 1 ? first : from === last + 1 && to === first - 1 ? last : 0;
      if (!target) continue;
      const line = doc.line(target);
      const head = line.from + Math.min(before.head - doc.lineAt(before.head).from, line.length);
      return [transaction, { selection: EditorSelection.cursor(head), sequential: true }];
    }
    return transaction;
  });
}

export function visibleLines(state: EditorState, ranges: readonly VisibleRange[]): number[] {
  const lines = new Set<number>();
  for (const range of ranges) {
    const last = state.doc.lineAt(range.to).number;
    for (let line = state.doc.lineAt(range.from).number; line <= last; line++) lines.add(line);
  }
  return [...lines].sort((a, b) => a - b);
}

export function insideLiteral(state: EditorState, position: number, skipImage = false): boolean {
  for (let node = syntaxTree(state).resolve(position, 1); node; ) {
    if (["FencedCode", "CodeBlock", "InlineCode", "HTMLBlock", "HTMLTag", "Table", "URL"].includes(node.name) ||
        (skipImage && node.name === "Image")) return true;
    if (!node.parent) break;
    node = node.parent;
  }
  return false;
}
