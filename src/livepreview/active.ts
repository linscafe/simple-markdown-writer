import type { EditorState } from "@codemirror/state";

export function activeLines(state: EditorState): Set<number> {
  const lines = new Set<number>();
  for (const range of state.selection.ranges) {
    const last = state.doc.lineAt(range.to).number;
    for (let line = state.doc.lineAt(range.from).number; line <= last; line++) {
      lines.add(line);
    }
  }
  return lines;
}

export function isActive(state: EditorState, from: number, to: number): boolean {
  const first = state.doc.lineAt(from).number;
  const last = state.doc.lineAt(to).number;
  return state.selection.ranges.some((range) =>
    state.doc.lineAt(range.from).number <= last &&
    state.doc.lineAt(range.to).number >= first,
  );
}
