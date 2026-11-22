import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { EditorState } from "@codemirror/state";
import { beforeAll, describe, expect, it } from "vitest";
import { generateLarge } from "../samples/gen-large.mjs";
import { previewViewport, type VisibleRange } from "./livepreview/blocks";
import { findCodeBlocks } from "./livepreview/codeblock";
import { computePreview } from "./livepreview/hide";
import { findImages } from "./livepreview/images";
import { livePreview } from "./livepreview/index";
import { findMathRanges, inDisplayMath, mathBlockIndex } from "./livepreview/math-ranges";
import { findTables } from "./livepreview/tables";

const budget = 20;
const lineCount = 10000;
let state: EditorState;
let visible: VisibleRange[];

function time(label: string, run: () => unknown): number {
  for (let i = 0; i < 5; i++) run();
  const runs = 20;
  const start = performance.now();
  for (let i = 0; i < runs; i++) run();
  const average = (performance.now() - start) / runs;
  console.log(`perf: ${label} ${average.toFixed(3)} ms`);
  return average;
}

beforeAll(() => {
  const doc = generateLarge(lineCount);
  const created = performance.now();
  const initial = EditorState.create({
    doc,
    extensions: [markdown({ base: markdownLanguage }), livePreview({ path: "/notes/large.md", dir: "/notes" })],
  });
  console.log(`perf: create state ${(performance.now() - created).toFixed(1)} ms`);
  const first = initial.doc.line(lineCount / 2), last = initial.doc.line(lineCount / 2 + 59);
  visible = [{ from: first.from, to: last.to }];
  ensureSyntaxTree(initial, last.to, 5000);
  state = initial.update({ selection: { anchor: initial.doc.line(lineCount / 2 - 200).from } }).state;
});

describe("large document performance", () => {
  it("parses only up to the visible range", () => {
    expect(state.doc.lines).toBeGreaterThanOrEqual(lineCount);
    expect(syntaxTree(state).length).toBeGreaterThanOrEqual(visible[0].to);
    expect(syntaxTree(state).length).toBeLessThan(state.doc.length);
  });

  it.each([
    ["computePreview", computePreview],
    ["findTables", findTables],
    ["findMathRanges", findMathRanges],
    ["findCodeBlocks", findCodeBlocks],
    ["findImages", findImages],
  ] as const)("%s handles a 60-line viewport without a full parse", (name, find) => {
    const treeLength = syntaxTree(state).length;
    const found = find(state, visible);
    expect(found.length).toBeGreaterThan(0);
    for (const item of found) expect(item.to).toBeGreaterThanOrEqual(visible[0].from - 2000);
    expect(time(name, () => find(state, visible))).toBeLessThan(budget);
    expect(syntaxTree(state).length).toBe(treeLength);
  });

  it("keeps viewport and keystroke updates within budget", () => {
    const viewport = () => state.update({ effects: previewViewport.of(visible) }).state;
    expect(time("viewport update", viewport)).toBeLessThan(budget);
    const shown = viewport();
    expect(time("computePreview with block previews", () => computePreview(shown, visible))).toBeLessThan(budget);
    expect(computePreview(shown, visible).length).toBeGreaterThan(0);
    const at = shown.doc.line(lineCount / 2 + 30).from;
    expect(time("keystroke", () => shown.update({ changes: { from: at, insert: "x" }, selection: { anchor: at + 1 } }).state))
      .toBeLessThan(budget);
    expect(time("cursor move", () => shown.update({ selection: { anchor: at } }).state)).toBeLessThan(budget);
  });

  it("updates the display math index incrementally like a full rebuild", () => {
    const extensions = [markdown({ base: markdownLanguage }), mathBlockIndex];
    const parsed = (next: EditorState) => {
      ensureSyntaxTree(next, next.doc.length, 5000);
      return next.update({}).state;
    };
    const blocks = (next: EditorState) => findMathRanges(next, [{ from: 0, to: next.doc.length }])
      .filter((range) => range.block).map(({ from, to, expression }) => [from, to, expression]);
    const doc = generateLarge(300) + "```\n$$\nnot math\n$$\n```\n";
    const unparsed = EditorState.create({ doc, extensions });
    expect(syntaxTree(unparsed).length).toBeLessThan(doc.length);
    blocks(unparsed);
    let current = parsed(unparsed);
    expect(blocks(current)).toEqual(blocks(parsed(EditorState.create({ doc, extensions }))));
    const edits: ((doc: string) => { from: number; to?: number; insert?: string })[] = [
      (doc) => ({ from: doc.indexOf("$$\n"), insert: "$$\n" }),
      (doc) => ({ from: doc.indexOf("```ts"), insert: "```\n" }),
      (doc) => ({ from: doc.lastIndexOf("$$\n\\int"), insert: "| a |\n" }),
      (doc) => ({ from: doc.lastIndexOf("| a |\n") + 6, insert: "| - |\n" }),
      (doc) => ({ from: doc.indexOf("```\n"), to: doc.indexOf("```\n") + 4 }),
      (doc) => ({ from: doc.length, insert: "\n$$\nx\n" }),
      () => ({ from: 0, insert: "$$y$$\n" }),
      (doc) => ({ from: doc.indexOf("$$\n"), to: doc.indexOf("$$\n") + 3 }),
      (doc) => ({ from: doc.indexOf("## Section 6\n"), insert: "$$a|b$$\n" }),
      (doc) => ({ from: doc.indexOf("$$a|b$$\n") + 8, insert: "|-|-|\n" }),
    ];
    edits.forEach((edit, i) => {
      if (i % 2) inDisplayMath(current, current.doc.length >> 1);
      else blocks(current);
      const edited = current.update({ changes: edit(current.doc.toString()) }).state;
      const reference = parsed(EditorState.create({ doc: edited.doc, extensions }));
      current = parsed(edited);
      expect(blocks(current)).toEqual(blocks(reference));
    });
  });
});
