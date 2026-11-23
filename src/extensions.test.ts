import { EditorState } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";
import { EditorView } from "@codemirror/view";
import { describe, expect, it, vi } from "vitest";
import { buildExtensions } from "./extensions";

const catalogLoaded = vi.hoisted(() => vi.fn());
vi.mock("@codemirror/language-data", async (importOriginal) => {
  catalogLoaded();
  return importOriginal();
});

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

  it("loads grammars on the first tagged fence and reparses without another edit", async () => {
    Object.defineProperties(Range.prototype, {
      getClientRects: { configurable: true, value: () => [] },
      getBoundingClientRect: { configurable: true, value: () => new DOMRect() },
    });
    const view = new EditorView({
      parent: document.body,
      doc: "Plain prose\n\n```\nuntagged\n```",
      extensions: buildExtensions({ path: "/tmp/test.md", dir: "/tmp", save: async () => {}, quit: () => {} }),
    });
    try {
      await vi.dynamicImportSettled();
      expect(catalogLoaded).not.toHaveBeenCalled();
      const fences = "\n\n```ts title\nconst value: number = 1\n```\n\n```xyzzy\nplain\n```";
      view.dispatch({ changes: { from: view.state.doc.length, insert: fences } });
      const type = view.state.doc.toString().indexOf("number");
      await vi.waitFor(() => {
        expect(syntaxTree(view.state).resolveInner(type + 1).name).toBe("TypeName");
      }, { timeout: 3000 });
      expect(catalogLoaded).toHaveBeenCalledTimes(1);
      const unknown = view.state.doc.toString().indexOf("plain");
      expect(syntaxTree(view.state).resolveInner(unknown + 1).name).toBe("CodeText");
    } finally {
      view.destroy();
    }
  });
});
