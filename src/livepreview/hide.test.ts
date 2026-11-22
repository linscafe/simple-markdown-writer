import { ensureSyntaxTree } from "@codemirror/language";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { EditorSelection, EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { computePreview } from "./hide";

function stateFor(doc: string, anchor = doc.length): EditorState {
  const state = EditorState.create({
    doc, selection: { anchor }, extensions: markdown({ base: markdownLanguage }),
  });
  expect(ensureSyntaxTree(state, doc.length, 5000)).not.toBeNull();
  return state;
}

function preview(state: EditorState) {
  return computePreview(state, [{ from: 0, to: state.doc.length }]);
}

function hiddenText(state: EditorState): string[] {
  return preview(state).filter((range) => range.kind === "hide")
    .map((range) => state.sliceDoc(range.from, range.to));
}

describe("inline preview decisions", () => {
  it("hides heading markup and styles the line only while inactive", () => {
    const state = stateFor("# Hi\n\ncursor");
    expect(hiddenText(state)).toEqual(["# "]);
    expect(preview(state)).toContainEqual({ from: 0, to: 0, kind: "line", className: "cm-h1" });
    expect(preview(stateFor("# Hi", 0))).toEqual([]);
  });

  it("hides strong marks and a link destination, preserving text and its href", () => {
    const state = stateFor('**b** [t](u "title")\n\ncursor');
    expect(hiddenText(state)).toEqual(["**", "**", "[", '](u "title")']);
    expect(preview(state)).toContainEqual({ from: 7, to: 8, kind: "mark", className: "cm-md-link", href: "u" });
    expect(preview(state)).toContainEqual({ from: 0, to: 5, kind: "mark", className: "cm-md-strong" });
    expect(hiddenText(stateFor("[t](u)\n\ncursor"))).toEqual(["[", "](u)"]);
  });

  it("handles emphasis, strikethrough, inline code, escapes, and closing heading marks", () => {
    const state = stateFor("## Hi ##\n\n*e* ~~s~~ `c` \\*\n\ncursor");
    expect(hiddenText(state)).toEqual(["## ", "##", "*", "*", "~~", "~~", "`", "`", "\\"]);
    expect(preview(state).filter((range) => range.kind === "mark").map((range) => range.className))
      .toEqual(["cm-md-em", "cm-md-strike", "cm-md-code"]);
  });

  it("styles autolinks and GFM bare URLs", () => {
    const state = stateFor("<https://a.test> https://b.test <a@b.test>\n\ncursor");
    expect(hiddenText(state)).toEqual(["<", ">", "<", ">"]);
    expect(preview(state).filter((range) => range.className === "cm-md-link").map((range) => range.href))
      .toEqual(["https://a.test", "https://b.test", "mailto:a@b.test"]);
  });

  it("styles empty destinations and angle-bracket destinations", () => {
    const state = stateFor('[t]() [t](<a b> "title")\n\ncursor');
    expect(hiddenText(state)).toEqual(["[", "]()", "[", '](<a b> "title")']);
    expect(preview(state).filter((range) => range.className === "cm-md-link").map((range) => range.href))
      .toEqual(["", "a b"]);
  });

  it("styles setext headings while leaving their underlines visible and muted", () => {
    const state = stateFor("Heading\n=======\n\ncursor");
    expect(hiddenText(state)).toEqual([]);
    expect(preview(state)).toEqual([
      { from: 0, to: 0, kind: "line", className: "cm-h1" },
      { from: 8, to: 15, kind: "mark", className: "cm-md-setext" },
    ]);
  });

  it("replaces bullets, task markers, and horizontal rules, and mutes ordered markers", () => {
    const state = stateFor("- bullet\n- [ ] todo\n- [X] done\n\n1. ordered\n2. [x] task\n\n---\n\ncursor");
    const ranges = preview(state);
    expect(ranges.filter((range) => range.kind === "bullet")).toHaveLength(1);
    expect(ranges.filter((range) => range.kind === "checkbox").map((range) => range.checked))
      .toEqual([false, true, true]);
    expect(ranges.filter((range) => range.kind === "hr")).toHaveLength(1);
    expect(ranges.filter((range) => range.className === "cm-md-list-number")
      .map((range) => state.sliceDoc(range.from, range.to))).toEqual(["1."]);
    expect(hiddenText(state)).toEqual(["- ", "- ", "2. "]);
  });

  it("reveals only active quote lines and keeps a border on inactive lines", () => {
    const state = stateFor("> one\n> two\n> three", 8);
    expect(hiddenText(state)).toEqual(["> ", "> "]);
    expect(preview(state).filter((range) => range.kind === "line").map((range) => range.from)).toEqual([0, 12]);
  });

  it("splits multiline styles and hides around active lines without replacing newlines", () => {
    const state = stateFor("**one\ntwo\nthree**\n\n[t](url\n \"title\")\n\ncursor", 7);
    const ranges = preview(state);
    for (const range of ranges) {
      expect(state.sliceDoc(range.from, range.to)).not.toContain("\n");
      expect(state.doc.lineAt(range.from).number).not.toBe(2);
    }
    expect(hiddenText(state)).toEqual(["**", "**", "[", "](url", ' "title")']);
  });

  it("reveals every line touched by any selection", () => {
    const initial = stateFor("# A\n**B**\n- [ ] C\n\n# D");
    const state = initial.update({ selection: EditorSelection.range(2, 12) }).state;
    expect(preview(state).filter((range) => range.from < 17)).toEqual([]);
    expect(hiddenText(state)).toEqual(["# "]);
  });

  it("limits all work to the visible lines, including multiline inline nodes", () => {
    const state = stateFor("**one\ntwo\nthree**\n\n# outside\n\ncursor");
    const line = state.doc.line(2);
    expect(computePreview(state, [{ from: line.from, to: line.to }])).toEqual([
      { from: line.from, to: line.to, kind: "mark", className: "cm-md-strong" },
    ]);
  });

  it("leaves images, fences, indented code, tables, and HTML blocks untouched", () => {
    const doc = '![*alt*](image.png)\n\n```md\n# heading\n**raw**\n```\n\n    **code**\n\n| A | B |\n| - | - |\n| *C* | `D` |\n\n<div>\n*raw*\n</div>\n\ncursor';
    expect(preview(stateFor(doc))).toEqual([]);
  });

  it("keeps replacement decorations on single lines across a mixed document", () => {
    const state = stateFor('# H\n\n> **quote**\n> [t](url\n> "title")\n\n- [ ] task\n\n***\n\n`multiline\ncode`\n\ncursor');
    for (const range of preview(state)) {
      if (range.kind !== "line" && range.kind !== "mark") {
        expect(state.sliceDoc(range.from, range.to)).not.toContain("\n");
      }
    }
  });
});
