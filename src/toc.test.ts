import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { currentHeading, documentHeadings, setTocVisible, tocExtension } from "./toc";

const source = [
  "# Title", "", "Intro", "", "## **Bold** [link](x.md) ##", "", "```", "# not a heading", "```", "",
  "Setext", "------", "", "> ### Quoted", "", "####",
].join("\n");

function state(doc = source) {
  return EditorState.create({ doc, extensions: [markdown({ base: markdownLanguage })] });
}

describe("table of contents", () => {
  it("lists headings with levels and plain text", () => {
    expect(documentHeadings(state()).map(({ level, text }) => [level, text])).toEqual([
      [1, "Title"], [2, "Bold link"], [2, "Setext"], [3, "Quoted"], [4, "(untitled)"],
    ]);
  });

  it("finds the heading that contains a position", () => {
    const headings = documentHeadings(state());
    expect(currentHeading(headings, 0)).toBe(0);
    expect(currentHeading(headings, source.indexOf("not a heading"))).toBe(1);
    expect(currentHeading(headings, source.length)).toBe(4);
    expect(currentHeading([], 3)).toBe(-1);
  });

  it("shows, hides and jumps to a heading", () => {
    const view = new EditorView({ state: EditorState.create({
      doc: source, extensions: [markdown({ base: markdownLanguage }), tocExtension({ showToc: false })],
    }), parent: document.body });
    const nav = view.dom.querySelector<HTMLElement>(".mdw-toc")!;
    expect(nav.hidden).toBe(true);
    setTocVisible(view, true);
    expect(nav.hidden).toBe(false);
    expect(view.dom.classList.contains("mdw-toc-open")).toBe(true);
    const buttons = nav.querySelectorAll("button");
    expect(buttons).toHaveLength(5);
    buttons[2].click();
    expect(view.state.selection.main.head).toBe(source.indexOf("Setext"));
    expect(buttons[2].getAttribute("aria-current")).toBe("location");

    view.setState(EditorState.create({ doc: "# Other", extensions: [markdown({ base: markdownLanguage }), tocExtension({})] }));
    expect(view.dom.querySelector<HTMLElement>(".mdw-toc")!.hidden).toBe(false);
    view.destroy();
  });
});
