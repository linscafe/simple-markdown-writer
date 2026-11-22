import { StateEffect, type EditorState, type Range } from "@codemirror/state";
import { Decoration, ViewPlugin, WidgetType, type EditorView, type ViewUpdate } from "@codemirror/view";
import { isActive } from "./active";
import { enterSkippedBlocks, statePreview, visibleLines } from "./blocks";
import { findMathRanges, mathBlockIndex, type MathRange } from "./math-ranges";

let katex: typeof import("katex").default | undefined;
let loading: Promise<void> | undefined;
let loadFailed = false;
const mathLoaded = StateEffect.define<null>();

export class MathWidget extends WidgetType {
  constructor(readonly item: MathRange, readonly source: string) { super(); }
  eq(other: MathWidget): boolean { return this.source === other.source && this.item.block === other.item.block; }
  toDOM(view: EditorView): HTMLElement {
    const element = document.createElement(this.item.block ? "div" : "span");
    element.className = this.item.block ? "cm-md-math cm-md-math-block" : "cm-md-math";
    try {
      katex?.render(this.item.expression, element, { displayMode: this.item.block, throwOnError: true, trust: false });
    } catch {
      element.classList.add("cm-md-math-error");
      element.textContent = this.source;
    }
    element.addEventListener("mousedown", event => event.preventDefault());
    element.addEventListener("click", () => {
      view.dispatch({ selection: { anchor: view.posAtDOM(element) }, scrollIntoView: true });
      view.focus();
    });
    return element;
  }
}

const preview = statePreview({
  find: findMathRanges,
  refresh: mathLoaded,
  decorate(state, items, visible) {
    const ranges: Range<Decoration>[] = [];
    for (const item of items) {
      if (katex && !isActive(state, item.from, item.to)) {
        const widget = new MathWidget(item, state.sliceDoc(item.from, item.to));
        ranges.push(Decoration.replace({ block: item.block, widget }).range(item.from, item.to));
        continue;
      }
      let error = loadFailed;
      if (katex) {
        try { katex.renderToString(item.expression, { throwOnError: true, trust: false }); }
        catch { error = true; }
      }
      if (error || !katex) {
        const className = error ? "cm-md-math-error" : "cm-md-math-pending";
        if (item.block) {
          for (const number of visibleLines(state, visible)) {
            if (state.doc.line(number).from < item.from || state.doc.line(number).to > item.to) continue;
            ranges.push(Decoration.line({ class: className }).range(state.doc.line(number).from));
          }
        } else ranges.push(Decoration.mark({ class: className }).range(item.from, item.to));
      }
    }
    return Decoration.set(ranges, true);
  },
});

const mathLoader = ViewPlugin.fromClass(class {
  private destroyed = false;
  private subscribed = false;
  constructor(private view: EditorView) { this.load(); }
  update(_update: ViewUpdate): void { this.load(); }
  private load(): void {
    if (this.subscribed || katex || loadFailed || !this.view.state.field(preview.field).items.length) return;
    this.subscribed = true;
    loading ??= Promise.all([import("katex"), import("katex/dist/katex.min.css")])
      .then(([module]) => { katex = module.default; })
      .catch(() => { loadFailed = true; });
    void loading.then(() => {
      if (!this.destroyed) this.view.dispatch({ effects: mathLoaded.of(null) });
    });
  }
  destroy(): void { this.destroyed = true; }
});

export const mathPreview = [mathBlockIndex, preview.extension, enterSkippedBlocks(preview.field, (item) => item.block && katex !== undefined), mathLoader];

export function mathItems(state: EditorState): readonly MathRange[] {
  return state.field(preview.field, false)?.items ?? [];
}

export function mathAt(state: EditorState, pos: number): boolean {
  return mathItems(state).some(({ from, to }) => from <= pos && pos < to);
}
