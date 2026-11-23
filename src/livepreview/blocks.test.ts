import { ensureSyntaxTree } from "@codemirror/language";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { EditorSelection, EditorState, type Extension } from "@codemirror/state";
import { Decoration, EditorView } from "@codemirror/view";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isActive } from "./active";
import { previewViewport, statePreview } from "./blocks";
import { findCodeBlocks } from "./codeblock";
import { findImages, ImageWidget, parseImages, resolveImageSources } from "./images";
import { livePreview } from "./index";
import { findMathRanges, mathBlockIndex } from "./math-ranges";
import { findTables, parseTable, renderInline, splitTableRow } from "./tables";

vi.mock("@tauri-apps/api/path", () => ({ join: async (...parts: string[]) => parts.join("/") }));
vi.mock("@tauri-apps/api/core", () => ({ convertFileSrc: (path: string) => `asset:${path}` }));

const context = { path: "/notes/note.md", dir: "/notes" };
function stateFor(doc: string, extensions: Extension = []): EditorState {
  const state = EditorState.create({
    doc, selection: { anchor: doc.length },
    extensions: [markdown({ base: markdownLanguage }), mathBlockIndex, EditorState.allowMultipleSelections.of(true), extensions],
  });
  ensureSyntaxTree(state, doc.length, 5000);
  return state;
}

describe("table parsing", () => {
  it("reads delimiter alignment and absolute source positions", () => {
    const table = parseTable("| Left | Center | Right | None |\n| :-- | :-: | --: | --- |\n| a | b | c | d |", 50)!;
    expect(table.alignments).toEqual(["left", "center", "right", null]);
    expect(table.rows[0][0]).toEqual({ text: "Left", from: 52, to: 56 });
    expect(table.rows[1].map((cell) => cell.text)).toEqual(["a", "b", "c", "d"]);
  });

  it("keeps escaped pipes and pipes in matching backtick runs inside cells", () => {
    expect(splitTableRow("| a\\|b | `x|y` | ``x`|y`` |").map((cell) => cell.text))
      .toEqual(["a\\|b", "`x|y`", "``x`|y``"]);
    expect(splitTableRow("a | b").map((cell) => cell.text)).toEqual(["a", "b"]);
    expect(splitTableRow("| `open | next |").map((cell) => cell.text)).toEqual(["`open", "next"]);
  });

  it("rejects malformed delimiters and fills missing cells", () => {
    expect(parseTable("| a | b |\n| --- | nope |")).toBeNull();
    expect(parseTable("| a | b |\n| --- |")).toBeNull();
    expect(parseTable("| a | b |\n| --- | --- |\n| x |")!.rows[1].map((cell) => cell.text)).toEqual(["x", ""]);
  });

  it("renders minimal inline markup safely", () => {
    const parent = document.createElement("span");
    renderInline('**bold** *italic* `a|b` [link](https://example.com) a\\|b <img src=x> [bad](javascript:alert)', parent);
    expect(parent.querySelector("strong")?.textContent).toBe("bold");
    expect(parent.querySelector("em")?.textContent).toBe("italic");
    expect(parent.querySelector("code")?.textContent).toBe("a|b");
    expect(parent.querySelector("a")?.getAttribute("href")).toBe("https://example.com");
    expect(parent.querySelectorAll("a")[1].hasAttribute("href")).toBe(false);
    expect(parent.querySelector("img")).toBeNull();
    expect(parent.textContent).toContain("a|b <img src=x>");
  });
});

describe("math detection", () => {
  function math(doc: string) {
    const state = stateFor(doc);
    return findMathRanges(state, [{ from: 0, to: doc.length }]);
  }

  it("requires non-space delimiters and rejects currency and escaped dollars", () => {
    expect(math("$5 and $10; $ spaced$; $trailing $; \\$escaped$; $x+1$ and $y$")
      .map((range) => range.expression)).toEqual(["x+1", "y"]);
  });

  it("skips inline code, fenced code, and indented code", () => {
    expect(math("`$inline$` and $real$\n\n```tex\n$fake$\n$$\nx\n$$\n```\n\n    $indented$")
      .map((range) => range.expression)).toEqual(["real"]);
  });

  it("renders numeric formulas and recovers after an unmatched opening dollar", () => {
    expect(math("$2+2$ and $bad $valid$").map(r => r.expression)).toEqual(["2+2", "valid"]);
  });

  it("updates display delimiters across multi-cursor edits and line joins", () => {
    const doc = "intro\n$$\nx + y\n$$\nend";
    const expressions = (state: EditorState) =>
      findMathRanges(state, [{ from: 0, to: state.doc.length }]).map(r => r.expression);
    let state = stateFor(doc);
    state = state.update({ changes: [
      { from: 0, insert: "$$z$$\n" }, { from: doc.indexOf("y"), insert: "2" },
    ] }).state;
    expect(expressions(state)).toEqual(["z", "x + 2y"]);
    const closing = state.doc.line(5).from;
    state = state.update({ changes: { from: closing - 1, to: closing } }).state;
    expect(expressions(state)).toEqual(["z"]);
    state = state.update({ changes: { from: closing - 1, insert: "\n" } }).state;
    expect(expressions(state)).toEqual(["z", "x + 2y"]);
  });

  it("detects multiline and single-line display math", () => {
    expect(math("$$\nx^2\n\ny^2\n$$\n\n$$z^2$$").map((range) => [range.expression, range.block]))
      .toEqual([["x^2\n\ny^2", true], ["z^2", true]]);
  });

  it("finds the full block when only its middle is visible", () => {
    const state = stateFor("before\n\n$$\nx^2\ny^2\n$$\n\nafter");
    const line = state.doc.line(5);
    const ranges = findMathRanges(state, [{ from: line.from, to: line.to }]);
    expect(ranges).toHaveLength(1);
    expect(state.sliceDoc(ranges[0].from, ranges[0].to)).toBe("$$\nx^2\ny^2\n$$");
  });

  it("looks past the viewport for a closer and notices edits in the distant text", () => {
    const doc = "before\n\n$$\n" + "x\n".repeat(200) + "$$\n\nafter";
    const visible = [{ from: 0, to: doc.indexOf("x") }];
    const state = stateFor(doc);
    const close = doc.lastIndexOf("$$");
    expect(findMathRanges(state, visible).map(r => r.to)).toEqual([close + 2]);
    const opened = state.update({ changes: { from: close, to: close + 2 } }).state;
    expect(findMathRanges(opened, visible)).toEqual([]);
    const closed = opened.update({ changes: { from: opened.doc.length, insert: "\n$$" } }).state;
    expect(findMathRanges(closed, visible).map(r => r.to)).toEqual([closed.doc.length]);
  });
});

describe("image parsing and resolution", () => {
  it.each([
    ["![alt](file.png)", "alt", "file.png", undefined, undefined, false],
    ["![alt|300](file.png)", "alt", "file.png", 300, undefined, false],
    ["![alt|300x200](file.png)", "alt", "file.png", 300, 200, false],
    ["![alt](file.png){width=300}", "alt", "file.png", 300, undefined, false],
    ["![alt](file.png) {width=300}", "alt", "file.png", 300, undefined, false],
    ["![[file.png]]", "file.png", "file.png", undefined, undefined, true],
    ["![[ file.png|300 ]]", "file.png", "file.png", 300, undefined, true],
    ["![[file.png|300x200]]", "file.png", "file.png", 300, 200, true],
    ['![alt](<a b.png> "title")', "alt", "a b.png", undefined, undefined, false],
    ["![alt](a(b).png)", "alt", "a(b).png", undefined, undefined, false],
  ])("parses %s", (source, alt, src, width, height, wiki) => {
    const [image] = parseImages(source as string, 10);
    expect(image).toEqual({ from: 10, to: 10 + (source as string).length, src, alt, width, height, wiki });
  });

  it("skips escaped, blank and incomplete image syntax and images inside code", () => {
    expect(parseImages("\\![alt](x) ![[ ]] ![incomplete](")).toEqual([]);
    const state = stateFor("`![alt](code.png)`\n\n```\n![[fence.png]]\n```\n\n![real](real.png)");
    expect(findImages(state, [{ from: 0, to: state.doc.length }]).map((image) => image.src)).toEqual(["real.png"]);
  });

  it("decodes local paths and tries wiki images beside the note before its assets folder", async () => {
    expect(await resolveImageSources(parseImages("![a](image%20one.png)")[0], context)).toEqual(["asset:/notes/image one.png"]);
    expect(await resolveImageSources(parseImages("![a](a%20%23%25.png)")[0], context)).toEqual(["asset:/notes/a #%.png"]);
    expect(await resolveImageSources(parseImages("![[photo.png]]")[0], context))
      .toEqual(["asset:/notes/photo.png", "asset:/notes/note.assets/photo.png"]);
    expect(await resolveImageSources(parseImages("![a](https://example.com/a.png)")[0], context))
      .toEqual(["https://example.com/a.png"]);
  });

  it("preserves widgets across position changes but compares source and dimensions", () => {
    const image = parseImages("![alt|300](a.png)")[0];
    const widget = new ImageWidget(image, context, false, true);
    expect(widget.eq(new ImageWidget({ ...image, from: 20, to: 40 }, context, false, true))).toBe(true);
    expect(widget.eq(new ImageWidget({ ...image, src: "b.png" }, context, false, true))).toBe(false);
    expect(widget.eq(new ImageWidget({ ...image, width: 200 }, context, false, true))).toBe(false);
    expect(widget.eq(new ImageWidget(image, context, true, true))).toBe(false);
  });
});

describe("block activation and decoration caching", () => {
  it("keeps offscreen inline previews out of partially visible lines", () => {
    const doc = "$first$ ![[one.png]] | $last$ ![[two.png]]";
    const state = stateFor(doc);
    const visible = [{ from: doc.indexOf("|"), to: doc.length }];
    expect(findImages(state, visible).map(image => image.src)).toEqual(["two.png"]);
    expect(findMathRanges(state, visible).map(math => math.expression)).toEqual(["last"]);
  });

  it("activates full fences, tables and math for any touching selection", () => {
    const doc = "```ts\ncode\n```\n\n| A | B |\n| - | - |\n| a | b |\n\n$$\nx\n$$\n\nafter";
    const state = stateFor(doc);
    const visible = [{ from: 0, to: doc.length }];
    const blocks = [...findCodeBlocks(state, visible), ...findTables(state, visible), ...findMathRanges(state, visible)];
    expect(blocks).toHaveLength(3);
    for (const block of blocks) {
      expect(isActive(state, block.from, block.to)).toBe(false);
      const middle = state.doc.lineAt(block.from).number + 1;
      const active = state.update({ selection: EditorSelection.create([
        EditorSelection.cursor(state.doc.line(middle).from), EditorSelection.cursor(doc.length),
      ]) }).state;
      expect(isActive(active, block.from, block.to)).toBe(true);
      expect(isActive(state.update({ selection: EditorSelection.range(doc.length, block.to) }).state, block.from, block.to)).toBe(true);
    }
  });

  it("does not parse or rebuild while the active block set remains the same", () => {
    const find = vi.fn(() => [{ from: 0, to: 3 }]);
    const decorate = vi.fn(() => Decoration.none);
    const preview = statePreview({ find, decorate,
    });
    let state = stateFor("a\nb\n\nother", preview.extension);
    state = state.update({ effects: previewViewport.of([{ from: 0, to: state.doc.length }]) }).state;
    state = state.update({ selection: { anchor: 0 } }).state;
    const activeDecorations = state.field(preview.field);
    state = state.update({ selection: { anchor: 2 } }).state;
    expect(state.field(preview.field)).toBe(activeDecorations);
    expect(find).toHaveBeenCalledTimes(1);
    expect(decorate).toHaveBeenCalledTimes(2);
  });
});

describe("block preview integration", () => {
  let view: EditorView | undefined;
  let parent: HTMLElement;
  beforeEach(() => {
    Object.defineProperties(Range.prototype, {
      getClientRects: { configurable: true, value: () => [] },
      getBoundingClientRect: { configurable: true, value: () => new DOMRect() },
    });
    parent = document.createElement("div");
    document.body.append(parent);
  });
  afterEach(() => { view?.destroy(); view = undefined; parent.remove(); });
  async function create(doc: string): Promise<EditorView> {
    view = new EditorView({ parent, state: stateFor(doc, livePreview(context)) });
    await Promise.resolve();
    return view;
  }

  it("lands on a table's first or last line when a vertical step would skip it", async () => {
    const doc = "top\n\n| A | B |\n| - | - |\n| x | y |\n\nend";
    const editor = await create(doc);
    const line = (n: number) => editor.state.doc.line(n);
    const step = (from: number, to: number) => {
      editor.dispatch({ selection: { anchor: Math.min(line(from).from + 2, line(from).to) } });
      editor.dispatch({ selection: { anchor: Math.min(line(to).from + 2, line(to).to) } });
      return editor.state.doc.lineAt(editor.state.selection.main.head).number;
    };
    expect(step(2, 6)).toBe(3);
    expect(editor.state.selection.main.head).toBe(line(3).from);
    expect(step(6, 2)).toBe(5);
    expect(step(1, 7)).toBe(7);
  });

  it("renders a table and reveals the whole source when a cell is clicked", async () => {
    const editor = await create("| A | B |\n| :- | -: |\n| **bold** | `c|d` |\n\ncursor");
    const cell = parent.querySelector<HTMLTableCellElement>("tbody td");
    expect(cell?.querySelector("strong")?.textContent).toBe("bold");
    expect(parent.querySelector<HTMLTableCellElement>("th:last-child")?.style.textAlign).toBe("right");
    cell?.click();
    await Promise.resolve();
    expect(parent.querySelector("table")).toBeNull();
    expect(parent.querySelectorAll(".cm-md-table-source")).toHaveLength(3);
    expect(editor.state.selection.main.head).toBe(editor.state.doc.line(3).from + 2);
  });

  it("splits tall tables into bounded widgets with one header", async () => {
    const rows = Array.from({ length: 40 }, (_, i) => `| r${i} | ${i} |`).join("\n");
    await create(`| A | B |\n| - | - |\n${rows}\n\ncursor`);
    const chunks = parent.querySelectorAll(".cm-md-table");
    expect(chunks.length).toBe(3);
    expect(parent.querySelectorAll("th")).toHaveLength(2);
    expect(parent.querySelectorAll("tbody tr")).toHaveLength(40);
    expect(chunks[0].classList.contains("cm-md-table-first")).toBe(true);
    expect(chunks[2].classList.contains("cm-md-table-last")).toBe(true);
    const tables = [...parent.querySelectorAll<HTMLTableElement>(".cm-md-table table")];
    const widths = tables.map((table) => [...table.querySelectorAll("col")].map((col) => col.style.width).join());
    expect(new Set(widths).size).toBe(1);
    expect(tables[0].querySelectorAll("col")).toHaveLength(2);
  });

  it("leaves short tables sized to their content", async () => {
    await create("| A | B |\n| - | - |\n| x | y |\n\ncursor");
    const table = parent.querySelector<HTMLTableElement>(".cm-md-table table")!;
    expect(table.style.width).toBe("");
    expect(table.querySelector("colgroup")).toBeNull();
  });

  it("keeps code body text editable and reveals both fences from any body line", async () => {
    const editor = await create("```ts\nconst x = 1;\nconst y = 2;\n```\n\ncursor");
    expect(parent.querySelector(".cm-md-fence-label")?.textContent).toBe("ts");
    expect(parent.querySelectorAll(".cm-md-codeblock")).toHaveLength(4);
    editor.dispatch({ selection: { anchor: editor.state.doc.line(3).from } });
    expect(parent.querySelector(".cm-md-fence-label")).toBeNull();
    expect(parent.querySelector(".cm-line")?.textContent).toBe("```ts");
    expect(parent.querySelectorAll(".cm-md-codeblock")).toHaveLength(4);
  });

  it("keeps image DOM across unrelated edits and shows a thumbnail while active", async () => {
    const editor = await create("![alt|300x200](https://example.com/a.png)\n\ncursor");
    const image = parent.querySelector<HTMLImageElement>(".cm-md-image img");
    expect(image?.width).toBe(300);
    expect(image?.height).toBe(200);
    expect(parent.querySelector(".cm-md-image-standalone")).not.toBeNull();
    editor.dispatch({ changes: { from: editor.state.doc.length, insert: "!" } });
    expect(parent.querySelector(".cm-md-image img")).toBe(image);
    editor.dispatch({ selection: { anchor: 1 } });
    expect(parent.querySelector(".cm-line")?.textContent).toBe("![alt|300x200](https://example.com/a.png)");
    expect(parent.querySelector(".cm-md-image-thumbnail img")).not.toBeNull();
  });

  it("tries the assets directory on failure, then shows a path placeholder", async () => {
    await create("![[photo.png]]\n\ncursor");
    await Promise.resolve();
    await Promise.resolve();
    const image = parent.querySelector(".cm-md-image img")!;
    expect(image.getAttribute("src")).toBe("asset:/notes/photo.png");
    image.dispatchEvent(new Event("error"));
    expect(image.getAttribute("src")).toBe("asset:/notes/note.assets/photo.png");
    image.dispatchEvent(new Event("error"));
    expect(parent.querySelector(".cm-md-image-error")?.textContent).toBe("photo.png");
  });

  it("loads KaTeX on encounter, reveals complete blocks, and marks invalid input", async () => {
    const editor = await create("$x^2$\n\n$$\nx+y\n$$\n\n$\\notacommand$\n\ncursor");
    await vi.waitFor(() => expect(parent.querySelectorAll(".katex")).toHaveLength(2));
    expect(parent.querySelector(".cm-md-math-error")?.textContent).toBe("$\\notacommand$");
    editor.dispatch({ selection: { anchor: editor.state.doc.line(4).from } });
    expect(parent.querySelector(".cm-md-math-block")).toBeNull();
    expect(parent.textContent).toContain("$$");
  });

  it("lands inside a rendered display formula when a vertical step would skip it", async () => {
    const editor = await create("top\n\n$$\nx+y\n$$\n\nend");
    await vi.waitFor(() => expect(parent.querySelector(".cm-md-math-block")).not.toBeNull());
    const line = (n: number) => editor.state.doc.line(n);
    editor.dispatch({ selection: { anchor: line(2).from } });
    editor.dispatch({ selection: { anchor: line(6).from } });
    expect(editor.state.doc.lineAt(editor.state.selection.main.head).number).toBe(3);
    expect(parent.querySelector(".cm-md-math-block")).toBeNull();
  });

  it("preserves every line of an active formula, including Markdown punctuation", async () => {
    const doc = "$$\n**raw**\nx+y\n![[sample.png]]\n$$\n\nafter";
    const editor = await create(doc);
    editor.dispatch({ selection: { anchor: doc.indexOf("x+y") } });
    await Promise.resolve();
    expect(parent.querySelector(".cm-content")?.textContent).toContain("**raw**");
    expect(parent.querySelector(".cm-md-image")).toBeNull();
  });

  it("keeps image and math source visible throughout an active table", async () => {
    const editor = await create("| A | B |\n| - | - |\n| $x$ | ![[pic.png]] |\n\ncursor");
    editor.dispatch({ selection: { anchor: 2 } });
    await Promise.resolve();
    expect(parent.querySelectorAll(".cm-md-table-source")[2]?.textContent).toBe("| $x$ | ![[pic.png]] |");
  });
});
