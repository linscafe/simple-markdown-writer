import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { describe, expect, it } from "vitest";
import { linkPasteExtension, pastedLink } from "./links";

describe("URL paste decisions", () => {
  it.each([
    ["https://example.com", "site", "[site](https://example.com)"],
    ["https://example.com", "", "<https://example.com>"],
    ["mailto:a@example.com", "", "<mailto:a@example.com>"],
    ["https://example.com/photo.JPG?size=2#preview", "", "![](https://example.com/photo.JPG?size=2#preview)"],
    ["https://example.com/photo.svg", "label", "[label](https://example.com/photo.svg)"],
    ["https://example.com/a(b).png", "", "![](https://example.com/a%28b%29.png)"],
    ["ordinary text", "selection", null],
    ["https://example.com\nother", "", null],
    [" https://example.com", "", null],
    ["javascript:alert(1)", "", null],
  ])("pastes %s over %s", (text, selection, expected) => {
    expect(pastedLink(text, selection)).toBe(expected);
  });

  it("only transforms DOM paste, and leaves ordinary paste to CodeMirror", () => {
    const view = new EditorView({ state: EditorState.create({ doc: "label", selection: { anchor: 0, head: 5 }, extensions: [linkPasteExtension()] }) });
    try {
      const event = new Event("paste", { bubbles: true, cancelable: true });
      Object.defineProperty(event, "clipboardData", { value: { items: [], getData: () => "https://example.com" } });
      view.contentDOM.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
      expect(view.state.doc.toString()).toBe("[label](https://example.com)");
      view.dispatch({ changes: { from: view.state.doc.length, insert: "plain vim register text" } });
      expect(view.state.doc.toString()).toContain("plain vim register text");
    } finally { view.destroy(); }
  });
});
