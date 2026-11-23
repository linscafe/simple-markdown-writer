import { language } from "@codemirror/language";
import type { EditorView } from "@codemirror/view";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEditor, setEditorSourceView } from "./editor";
import { isMarkdownPath } from "./mode";
import { setTocVisible } from "./toc";

vi.mock("./fsapi", () => ({ onDocChangedOnDisk: vi.fn(async () => () => {}) }));

describe("document modes", () => {
  let views: EditorView[] = [];
  const open = (path: string, content: string) => {
    const parent = document.createElement("div");
    document.body.append(parent);
    const view = createEditor({ parent, path, dir: "/tmp", content, writeFile: async () => {}, quit: () => {} });
    views.push(view);
    return view;
  };

  beforeEach(() => {
    Object.defineProperties(Range.prototype, {
      getClientRects: { configurable: true, value: () => [] },
      getBoundingClientRect: { configurable: true, value: () => new DOMRect() },
    });
  });

  afterEach(() => {
    for (const view of views) { view.destroy(); view.dom.parentElement?.remove(); }
    views = [];
  });

  it("recognises Markdown paths", () => {
    for (const path of ["/a/note.md", "/a/NOTE.Markdown", "/a/README", "/a.b/notes"]) expect(isMarkdownPath(path)).toBe(true);
    for (const path of ["/a/config.toml", "/a/list.txt", "/a/x.json"]) expect(isMarkdownPath(path)).toBe(false);
  });

  it("shows TOML as TOML source, not Markdown", async () => {
    const view = open("/tmp/config.toml", "# comment\ntheme = \"auto\"\n");
    expect(view.dom.classList.contains("mdw-source")).toBe(true);
    expect(view.state.facet(language)?.name).not.toBe("markdown");
    await vi.waitFor(() => expect(view.state.facet(language)?.name).toBe("toml"));
  });

  it("toggles Markdown between live preview and source", () => {
    const view = open("/tmp/note.md", "start\n\ntext **bold** text");
    const strong = () => view.dom.querySelector(".cm-md-strong");
    expect(strong()).not.toBeNull();
    setEditorSourceView(view, true);
    expect(strong()).toBeNull();
    expect(view.dom.classList.contains("mdw-source")).toBe(true);
    expect(view.state.facet(language)?.name).toBe("markdown");
    setEditorSourceView(view, false);
    expect(strong()).not.toBeNull();
    expect(view.dom.classList.contains("mdw-source")).toBe(false);
  });

  it("keeps the table of contents layout when switching to source", () => {
    const view = open("/tmp/note.md", "# A\n\ntext");
    setTocVisible(view, true);
    setEditorSourceView(view, true);
    view.focus();
    view.dispatch({ selection: { anchor: 3 } });
    expect(view.dom.classList.contains("mdw-toc-open")).toBe(true);
    expect(view.dom.classList.contains("mdw-source")).toBe(true);
    setTocVisible(view, false);
    expect(view.dom.classList.contains("mdw-toc-open")).toBe(false);
  });
});
