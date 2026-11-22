import { EditorSelection, EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { activeLines, isActive } from "./active";

describe("active lines", () => {
  it("includes every line of a reversed multiline selection, including its endpoints", () => {
    const state = EditorState.create({
      doc: "one\ntwo\nthree\nfour",
      selection: EditorSelection.range(8, 1),
    });
    expect([...activeLines(state)]).toEqual([1, 2, 3]);
    expect(isActive(state, 4, 7)).toBe(true);
    expect(isActive(state, 14, 18)).toBe(false);
  });

  it("includes all selection ranges and a line touched at its start", () => {
    const state = EditorState.create({
      doc: "a\nb\nc\nd\ne",
      selection: EditorSelection.create([
        EditorSelection.range(0, 2), EditorSelection.cursor(6),
      ]),
      extensions: EditorState.allowMultipleSelections.of(true),
    });
    expect([...activeLines(state)]).toEqual([1, 2, 4]);
    expect(isActive(state, 4, 6)).toBe(true);
    expect(isActive(state, 4, 5)).toBe(false);
  });
});
