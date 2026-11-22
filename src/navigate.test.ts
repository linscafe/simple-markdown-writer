import { EditorState } from "@codemirror/state";
import { markdown } from "@codemirror/lang-markdown";
import { getCM, Vim } from "@replit/codemirror-vim";
import type { EditorView } from "@codemirror/view";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { classifyLink, headings, linkAt, resolveDocumentPath, retargetHistory, slug } from "./navigate";
import { createEditor } from "./editor";
import { isDirty, statusMessage } from "./document";
import { openDocument, openExternal } from "./fsapi";

vi.mock("./fsapi", () => ({
  openDocument: vi.fn(), openExternal: vi.fn(async () => {}),
  onDocChangedOnDisk: vi.fn(async () => () => {}),
}));

const state = (doc: string) => EditorState.create({ doc, extensions: [markdown()] });

describe("link targets and headings", () => {
  it.each([
    ["https://example.com", { kind: "external", url: "https://example.com" }],
    ["mailto:a@example.com", { kind: "external", url: "mailto:a@example.com" }],
    ["#hello-world", { kind: "anchor", anchor: "hello-world" }],
    ["../note.md#topic", { kind: "markdown", path: "../note.md", anchor: "topic" }],
    ["[[note|label]]", { kind: "wikilink", path: "note.md", anchor: "" }],
    ["[[note.md#topic]]", { kind: "wikilink", path: "note.md", anchor: "topic" }],
    ["file.pdf", { kind: "file", path: "file.pdf", anchor: "" }],
    ["javascript:evil.md", { kind: "file", path: "javascript:evil.md", anchor: "" }],
  ])("classifies %s", (target, expected) => expect(classifyLink(target)).toEqual(expected));

  it("generates GitHub slugs with punctuation, Unicode, and duplicate suffixes", () => {
    expect(slug("Hello, World!" )).toBe("hello-world");
    expect(slug("中文 & _Under_score_" )).toBe("中文--_under_score_");
    const used = new Set<string>();
    expect(["Foo", "Foo", "Foo-1", "Foo"].map((text) => slug(text, used))).toEqual(["foo", "foo-1", "foo-1-1", "foo-2"]);
  });

  it("extracts rendered heading text and ignores headings inside code", () => {
    const doc = "# Hello *World*!\n\nHello World!\n===\n\n```md\n# Ignored\n```\n\n## [Link](note.md) `code`\n";
    expect(headings(state(doc)).map(({ text, slug }) => [text, slug])).toEqual([
      ["Hello World!", "hello-world"], ["Hello World!", "hello-world-1"], ["Link code", "link-code"],
    ]);
  });

  it("finds raw Markdown, autolinks, and wikilinks outside code", () => {
    for (const [doc, position, expected] of [
      ["[label](other.md#topic)", 3, "other.md#topic"],
      ["[label](other.md#topic)", 12, "other.md#topic"],
      ["<a@example.com>", 4, "mailto:a@example.com"],
      ["[[some note]]", 4, "[[some note]]"],
      ["`[[some note]]`", 4, null],
      ["```\n[[some note]]\n```", 8, null],
    ] as const) expect(linkAt(state(doc), position)).toBe(expected);
  });

  it("resolves encoded relative paths on Unix and Windows", () => {
    expect(resolveDocumentPath("/notes/docs", "../my%20note.md")).toBe("/notes/my note.md");
    expect(resolveDocumentPath("C:\\notes\\docs", "../note.md")).toBe("C:/notes/note.md");
  });
});

describe("navigation lifecycle", () => {
  let view: EditorView;
  let parent: HTMLElement;
  let write: ReturnType<typeof vi.fn<(path: string, content: string) => Promise<void>>>;
  const first = "[Next](next.md)\n\n# First\n\n[Jump](#first)\n";
  const second = "# Second\n\n[Back](first.md)\n";
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperties(Range.prototype, {
      getClientRects: { configurable: true, value: () => [] },
      getBoundingClientRect: { configurable: true, value: () => new DOMRect() },
    });
    parent = document.createElement("div"); document.body.append(parent);
    write = vi.fn(async () => {});
    vi.mocked(openDocument).mockImplementation(async (path) => ({ path, content: path.endsWith("next.md") ? second : first }));
    view = createEditor({ parent, path: "/notes/first.md", dir: "/notes", content: first,
      fileStates: { "/notes/next.md": { cursor: 2, scroll_top: 0, last_used: 0 } }, writeFile: write, quit() {} });
  });
  afterEach(() => { view.destroy(); parent.remove(); });
  function key(keys: string) {
    const cm = getCM(view);
    if (!cm) throw new Error("Vim missing");
    Vim.handleKey(cm, keys, "test");
  }
  const follow = () => { key("g"); key("x"); };

  it("loads a fresh state, restores cursors, updates save path, and supports back/forward", async () => {
    follow();
    await vi.waitFor(() => expect(view.state.doc.toString()).toBe(second));
    expect(view.state.selection.main.head).toBe(2);
    expect(isDirty(view.state)).toBe(false);
    expect(parent.querySelector(".mdw-status-file")?.textContent).toBe("next.md");
    key("<C-o>");
    await vi.waitFor(() => expect(view.state.doc.toString()).toBe(first));
    expect(view.state.selection.main.head).toBe(0);
    key("<C-i>");
    await vi.waitFor(() => expect(view.state.doc.toString()).toBe(second));
    view.dispatch({ changes: { from: 0, insert: "edited " } });
    const cm = getCM(view);
    if (!cm) throw new Error("Vim missing");
    Vim.handleEx(cm as Parameters<typeof Vim.handleEx>[0], "w");
    await vi.waitFor(() => expect(write).toHaveBeenCalledWith("/notes/next.md", `edited ${second}`));
  });

  it("points history at a renamed document", async () => {
    follow();
    await vi.waitFor(() => expect(view.state.doc.toString()).toBe(second));
    retargetHistory(view, "/notes/first.md", "/notes/renamed.md");
    key("<C-o>");
    await vi.waitFor(() => expect(openDocument).toHaveBeenLastCalledWith("/notes/renamed.md"));
  });

  it("refuses dirty file navigation and leaves history intact on failure", async () => {
    view.dispatch({ changes: { from: first.length, insert: "dirty" } });
    follow();
    expect(view.state.field(statusMessage)).toContain("Unsaved changes");
    expect(openDocument).not.toHaveBeenCalled();
    expect(view.state.doc.toString()).toContain("dirty");
  });

  it("follows rendered Ctrl-click links and keeps anchor jumps in history", async () => {
    view.dispatch({ selection: { anchor: first.length } });
    const link = parent.querySelector<HTMLElement>(".cm-md-link[data-href='#first']");
    expect(link).not.toBeNull();
    link?.dispatchEvent(new MouseEvent("click", { ctrlKey: true, bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(view.state.selection.main.head).toBe(first.indexOf("# First")));
    parent.querySelector(".cm-content")?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", altKey: true, bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(view.state.selection.main.head).toBe(first.length));
    expect(openDocument).not.toHaveBeenCalled();
  });

  it("reports failed opens and allows editing afterward", async () => {
    vi.mocked(openDocument).mockRejectedValueOnce(new Error("permission denied"));
    follow();
    await vi.waitFor(() => expect(view.state.field(statusMessage)).toContain("permission denied"));
    expect(view.state.readOnly).toBe(false);
    expect(view.state.doc.toString()).toBe(first);
  });

  it("opens external links with gx", async () => {
    view.destroy();
    view = createEditor({ parent, path: "/notes/first.md", dir: "/notes", content: "[Site](https://example.com)", writeFile: write, quit() {} });
    follow();
    await vi.waitFor(() => expect(openExternal).toHaveBeenCalledWith("https://example.com"));
    expect(openDocument).not.toHaveBeenCalled();
  });
});
