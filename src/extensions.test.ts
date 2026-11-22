import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { buildExtensions } from "./extensions";

describe("extension registry", () => {
  it("creates a Markdown editor state", () => {
    const extensions = buildExtensions({
      path: "/tmp/note.md",
      dir: "/tmp",
      save: async () => {},
      quit: () => {},
    });
    expect(extensions.length).toBeGreaterThan(0);
    const state = EditorState.create({ doc: "# Hello\n\n- [ ] Task", extensions });
    expect(state.doc.line(1).text).toBe("# Hello");
  });
});
