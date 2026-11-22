import { ensureSyntaxTree } from "@codemirror/language";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { livePreview } from "./index";
import { previewPlugin } from "./hide";
import { toggleTask } from "./widgets";

describe("task transactions", () => {
  it.each(["[ ]", "[x]", "[X]"])("toggles %s and preserves the selection", (marker) => {
    const state = EditorState.create({ doc: `- ${marker} Task\n\ncursor`, selection: { anchor: 0 } });
    const transaction = toggleTask(state, 2);
    expect(transaction?.state.doc.toString()).toBe(`- ${marker === "[ ]" ? "[x]" : "[ ]"} Task\n\ncursor`);
    expect(transaction?.state.selection.eq(state.selection)).toBe(true);
    expect(transaction?.isUserEvent("input")).toBe(true);
  });

  it("ignores a position that is no longer a task marker", () => {
    expect(toggleTask(EditorState.create({ doc: "- text" }), 2)).toBeNull();
  });
});

describe("live preview view integration", () => {
  let view: EditorView;
  let parent: HTMLDivElement;

  beforeEach(() => {
    Object.defineProperties(Range.prototype, {
      getClientRects: { configurable: true, value: () => [] },
      getBoundingClientRect: { configurable: true, value: () => new DOMRect() },
    });
    parent = document.createElement("div");
    document.body.append(parent);
  });

  afterEach(() => { view?.destroy(); parent.remove(); });

  function create(doc: string): void {
    const state = EditorState.create({
      doc, selection: { anchor: doc.length },
      extensions: [markdown({ base: markdownLanguage }), livePreview()],
    });
    ensureSyntaxTree(state, doc.length, 5000);
    view = new EditorView({ state, parent });
  }

  it("toggles a checkbox through its DOM widget without activating its line", () => {
    create("- [ ] task\n\ncursor");
    const selection = view.state.selection;
    const checkbox = parent.querySelector<HTMLInputElement>(".cm-md-checkbox");
    expect(checkbox?.checked).toBe(false);
    const mouseDown = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    checkbox?.dispatchEvent(mouseDown);
    expect(mouseDown.defaultPrevented).toBe(true);
    checkbox?.click();
    expect(view.state.doc.line(1).text).toBe("- [x] task");
    expect(view.state.selection.eq(selection)).toBe(true);
    expect(parent.querySelector<HTMLInputElement>(".cm-md-checkbox")?.checked).toBe(true);
    parent.querySelector<HTMLInputElement>(".cm-md-checkbox")?.click();
    expect(view.state.doc.line(1).text).toBe("- [ ] task");
  });

  it("updates markup, line classes, and link attributes as the selection and document change", () => {
    create("# Heading\n\n[t](url)\n\ncursor");
    expect(parent.querySelector(".cm-h1")?.textContent).toBe("Heading");
    expect(parent.querySelector(".cm-md-link")?.getAttribute("data-href")).toBe("url");
    view.dispatch({ selection: { anchor: 0 } });
    expect(parent.querySelector(".cm-h1")).toBeNull();
    expect(parent.querySelector(".cm-line")?.textContent).toBe("# Heading");
    view.dispatch({ changes: { from: 15, to: 18, insert: "new" } });
    expect(parent.querySelector(".cm-md-link")?.getAttribute("data-href")).toBe("new");
    expect(view.plugin(previewPlugin)).not.toBeNull();
  });

  it("keeps actual replacements within lines and supplies no atomic ranges for Vim to skip", () => {
    create("# Heading\n- [ ] task\n\n---\n\nlast");
    expect(view.state.facet(EditorView.atomicRanges)).toEqual([]);
    const decorations = view.plugin(previewPlugin)?.decorations;
    expect(decorations).toBeDefined();
    let widgets = 0;
    decorations?.between(0, view.state.doc.length, (from, to, decoration) => {
      expect(view.state.sliceDoc(from, to)).not.toContain("\n");
      if (decoration.spec.widget) {
        widgets++;
        expect(decoration.spec.block ?? false).toBe(false);
        expect(decoration.spec.widget.lineBreaks).toBe(0);
      }
    });
    expect(widgets).toBe(2);
  });
});
