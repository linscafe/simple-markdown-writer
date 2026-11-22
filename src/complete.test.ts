import { CompletionContext } from "@codemirror/autocomplete";
import { markdown } from "@codemirror/lang-markdown";
import { EditorState } from "@codemirror/state";
import { describe, expect, it, vi } from "vitest";
import { completionContext, pathCompletionSource } from "./complete";
import { listDir, readFile } from "./fsapi";

vi.mock("./fsapi", () => ({ listDir: vi.fn(), readFile: vi.fn() }));

const context = { path: "/notes/note.md", dir: "/notes", save: async () => {}, quit() {} };
const source = pathCompletionSource(context);
const complete = (doc: string, pos = doc.length) => source(new CompletionContext(EditorState.create({ doc, extensions: [markdown()] }), pos, true));

describe("path completion", () => {
  it.each([
    ["](./img", { kind: "path", dir: "./", prefix: "img", from: 4, path: "./img" }],
    ["![](a/b/", { kind: "path", dir: "a/b/", prefix: "", from: 8, path: "a/b/" }],
    ["](other.md#he", { kind: "heading", dir: "", prefix: "he", from: 11, path: "other.md" }],
    ["](#", { kind: "heading", dir: "", prefix: "", from: 3, path: "" }],
    ["[[no", { kind: "wiki", dir: "", prefix: "no", from: 2, path: "no" }],
    ["plain", null], ["](https://example.com", null], ["](photo.png#", null],
  ])("detects context for %s", (before, expected) => expect(completionContext(before)).toEqual(expected));

  it("lists the detected directory and escapes Markdown paths", async () => {
    vi.mocked(listDir).mockResolvedValue([{ name: "img", is_dir: true }, { name: "my photo(1).png", is_dir: false }]);
    const result = await complete("[image](./i");
    expect(listDir).toHaveBeenLastCalledWith("/notes/note.md", "./");
    expect(result?.options.map((option) => option.label)).toEqual(["img/", "my%20photo%281%29.png"]);
    expect(result?.from).toBe(10);
    expect(typeof result?.options[0].apply).toBe("function");
  });

  it("completes headings from the current syntax tree with unique slugs", async () => {
    const result = await complete("# Hello!\n\n# Hello!\n\n[go](#he");
    expect(result?.options.map((option) => option.label)).toEqual(["hello", "hello-1"]);
  });

  it("reads another file for heading completion", async () => {
    vi.mocked(readFile).mockResolvedValue("# Other heading\n\n```\n# Ignored\n```");
    const result = await complete("[go](../other%20note.md#");
    expect(readFile).toHaveBeenLastCalledWith("/other note.md");
    expect(result?.options.map((option) => option.label)).toEqual(["other-heading"]);
  });

  it("offers only Markdown names for wikilinks", async () => {
    vi.mocked(listDir).mockResolvedValue([{ name: "note.md", is_dir: false }, { name: "image.png", is_dir: false }, { name: "sub", is_dir: true }]);
    const result = await complete("[[no");
    expect(result?.options.map((option) => option.label)).toEqual(["note"]);
  });

  it("ignores code and handles inaccessible directories", async () => {
    expect(await complete("```\n[link](./")).toBeNull();
    vi.mocked(listDir).mockRejectedValue(new Error("missing"));
    expect(await complete("[link](missing/")).toBeNull();
  });
});
