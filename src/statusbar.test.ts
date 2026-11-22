import { EditorSelection, EditorState, StateEffect } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { getCM, Vim, type CodeMirrorV } from "@replit/codemirror-vim";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEditor } from "./editor";
import { countWords } from "./statusbar";

describe("word count", () => {
  it.each([
    ["", 0],
    ["   \n\t", 0],
    ["# Hello, **world**! _Markdown_ ~~text~~ `code`.", 5],
    ["- [x] Write prose\n> quote\n---", 4],
    ["don't stop; l’été café nai\u0308ve 123", 6],
    ["你好世界", 4],
    ["中文 hello世界 test", 6],
    ["ひらがな カタカナ 한글", 10],
    ["𠀀𠀁", 2],
    ["** -- [] () > # 😀", 0],
    ["one,two/three_four—five", 5],
  ])("counts words in %j", (text, expected) => {
    expect(countWords(text)).toBe(expected);
  });
});

describe("status panel", () => {
  let view: EditorView | undefined;
  let parent: HTMLDivElement;

  beforeEach(() => {
    Object.defineProperties(Range.prototype, {
      getClientRects: { configurable: true, value: () => [] },
      getBoundingClientRect: { configurable: true, value: () => new DOMRect() },
    });
    parent = document.createElement("div");
    document.body.append(parent);
  });

  afterEach(() => {
    view?.destroy();
    parent.remove();
    vi.useRealTimers();
  });

  function editor(content = "one two\nthree four"): EditorView {
    view = createEditor({
      parent, path: "/tmp/note.md", dir: "/tmp", content,
      writeFile: async () => {}, quit: () => {},
    });
    return view;
  }

  function text(name: string): string | null | undefined {
    return parent.querySelector(`.mdw-status-${name}`)?.textContent;
  }

  function keys(...input: string[]): void {
    const cm = getCM(view!);
    if (!cm?.state.vim) throw new Error("Vim is disabled");
    for (const key of input) Vim.handleKey(cm as CodeMirrorV, key, "test");
  }

  it("shows mode, message, filename, words and position in order in a bottom panel", () => {
    editor();
    const panel = parent.querySelector(".cm-panels-bottom .mdw-status")!;
    expect(Array.from(panel.children, (child) => child.className)).toEqual([
      "mdw-status-mode", "mdw-status-message", "mdw-status-file", "mdw-status-words", "mdw-status-position",
    ]);
    expect(text("mode")).toBe("NORMAL");
    expect(text("file")).toBe("note.md");
    expect(text("words")).toBe("4 words");
    expect(text("position")).toBe("Ln 1, Col 1");
  });

  it("updates all required Vim mode labels", () => {
    editor();
    keys("i");
    expect(text("mode")).toBe("INSERT");
    keys("<Esc>", "v");
    expect(text("mode")).toBe("VISUAL");
    keys("<Esc>", "V");
    expect(text("mode")).toBe("V-LINE");
    keys("<Esc>", "R");
    expect(text("mode")).toBe("REPLACE");
    keys("<Esc>");
    expect(text("mode")).toBe("NORMAL");
  });

  it("shows pending keys and clears them after the command completes", () => {
    const instance = editor();
    const press = (key: string) => instance.contentDOM.dispatchEvent(new KeyboardEvent("keydown", {
      key, bubbles: true, cancelable: true,
    }));
    press("d");
    expect(text("message")).toBe("d");
    press("Escape");
    expect(text("message")).toBe("");
  });

  it("reports dirty state and quit refusal in the message area", () => {
    const instance = editor();
    instance.dispatch({ changes: { from: 0, insert: "changed " } });
    expect(text("file")).toBe("note.md [+]");
    const cm = getCM(instance) as CodeMirrorV;
    Vim.handleEx(cm, "q");
    expect(text("message")).toContain("Unsaved changes");
  });

  it("counts the selection and restores the document count on cursor movement", () => {
    const instance = editor();
    instance.dispatch({ selection: EditorSelection.range(0, 7) });
    expect(text("words")).toBe("2 selected words");
    instance.dispatch({ selection: EditorSelection.cursor(10) });
    expect(text("words")).toBe("4 words");
    expect(text("position")).toBe("Ln 2, Col 3");
    instance.dispatch({ changes: { from: 10, insert: " new " } });
    expect(text("words")).toBe("6 words");
  });

  it("counts all nonempty ranges, including when the primary selection is empty", () => {
    const instance = editor();
    instance.dispatch({ effects: StateEffect.appendConfig.of(EditorState.allowMultipleSelections.of(true)) });
    instance.dispatch({ selection: EditorSelection.create([
      EditorSelection.cursor(0), EditorSelection.range(8, 13),
    ], 0) });
    expect(text("words")).toBe("1 selected words");
    instance.dispatch({ selection: EditorSelection.create([
      EditorSelection.range(0, 3), EditorSelection.range(8, 13),
    ]) });
    expect(text("words")).toBe("2 selected words");
  });

  it("debounces large document counts and counts small selections immediately", () => {
    vi.useFakeTimers();
    const instance = editor("word ".repeat(12_000));
    expect(text("words")).toBe("… words");
    vi.advanceTimersByTime(100);
    instance.dispatch({ selection: EditorSelection.cursor(1) });
    vi.advanceTimersByTime(100);
    expect(text("words")).toBe("12000 words");
    instance.dispatch({ changes: { from: 0, insert: "new " } });
    expect(text("words")).toBe("… words");
    vi.advanceTimersByTime(199);
    expect(text("words")).toBe("… words");
    vi.advanceTimersByTime(1);
    expect(text("words")).toBe("12001 words");
    instance.dispatch({ selection: EditorSelection.range(0, 3) });
    expect(text("words")).toBe("1 selected words");
    instance.dispatch({ selection: EditorSelection.cursor(0) });
    expect(text("words")).toBe("12001 words");
  });

  it("cancels a pending count when the view is destroyed", () => {
    vi.useFakeTimers();
    editor("word ".repeat(12_000));
    const words = parent.querySelector(".mdw-status-words");
    view!.destroy();
    view = undefined;
    vi.advanceTimersByTime(200);
    expect(words?.textContent).toBe("… words");
  });
});
