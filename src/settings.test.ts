import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyConfig, persistEditorState, type AppState, type UserConfig } from "./settings";
import { setTheme } from "./theme";
import { statusMessage } from "./document";
import { createEditor } from "./editor";
import { getCM, Vim } from "@replit/codemirror-vim";

const config: UserConfig = {
  theme: "auto", font_body: "serif", font_mono: "monospace", font_size: 19, line_width: 850,
  vim: false, vim_maps: [], image_dir: "{name}.assets", copy_images: true,
  keymap: { zoom_in: ["Ctrl-="], zoom_out: ["Ctrl--"], zoom_reset: ["Ctrl-0"] }, warning: null,
};

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("settings and persistence", () => {
  it("disables Vim from config and clamps a cursor beyond a shortened document", () => {
    const view = createEditor({
      parent: document.body, path: "/note.md", dir: "/", content: "hello", cursor: 100,
      config, writeFile: async () => {}, quit: () => {},
    });
    try {
      expect(getCM(view)).toBeNull();
      expect(view.state.selection.main.head).toBe(5);
    } finally { view.destroy(); }
  });

  it("applies configured Vim mappings", () => {
    const view = createEditor({
      parent: document.body, path: "/note.md", dir: "/", content: "hello",
      config: { ...config, vim: true, vim_maps: [{ lhs: "Q", rhs: "l", mode: "normal" }] },
      writeFile: async () => {}, quit: () => {},
    });
    try {
      const cm = getCM(view)! as Parameters<typeof Vim.handleKey>[0];
      Vim.handleKey(cm, "Q", "test");
      expect(view.state.selection.main.head).toBe(1);
    } finally {
      Vim.unmap("Q", "normal");
      view.destroy();
    }
  });

  it("applies configured fonts, font size and line width", () => {
    applyConfig(config);
    const style = document.documentElement.style;
    expect(style.getPropertyValue("--font-body")).toBe("serif");
    expect(style.getPropertyValue("--font-mono")).toBe("monospace");
    expect(style.getPropertyValue("--font-size")).toBe("19px");
    expect(style.getPropertyValue("--line-width")).toBe("850px");
    applyConfig({ ...config, font_body: null, font_mono: null });
    expect(style.getPropertyValue("--font-body")).toBe("");
    expect(style.getPropertyValue("--font-mono")).toBe("");
  });

  it("restores scroll, debounces selection changes, and flushes the latest state before quit", async () => {
    vi.useFakeTimers();
    const view = new EditorView({
      parent: document.body,
      state: EditorState.create({ doc: "hello", selection: { anchor: 2 }, extensions: [statusMessage] }),
    });
    const measure = vi.spyOn(view, "requestMeasure").mockImplementation((request) => {
      if (request?.read) request.write?.(request.read(view), view);
    });
    const state: AppState = {
      theme: null, window: null,
      files: { "/note.md": { cursor: 2, scroll_top: 123, last_used: 1 } },
    };
    const write = vi.fn(async (_snapshot: AppState) => {});
    const persistence = persistEditorState(view, "/note.md", state, write);
    try {
      await persistence.restored;
      expect(view.scrollDOM.scrollTop).toBe(123);
      view.dispatch({ selection: { anchor: 3 } });
      await vi.advanceTimersByTimeAsync(1500);
      expect(write).not.toHaveBeenCalled();
      view.dispatch({ selection: { anchor: 4 } });
      await vi.advanceTimersByTimeAsync(1999);
      expect(write).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(write).toHaveBeenCalledTimes(1);
      expect(write.mock.calls[0][0].files["/note.md"].cursor).toBe(4);
      view.dispatch({ selection: { anchor: 5 } });
      view.scrollDOM.scrollTop = 456;
      await persistence.flush();
      expect(write).toHaveBeenCalledTimes(2);
      expect(write.mock.calls[1][0].files["/note.md"]).toMatchObject({ cursor: 5, scroll_top: 456 });
      expect(write.mock.calls[0][0].files["/note.md"].cursor).toBe(4);
      setTheme("nord");
      await persistence.flush();
      expect(write.mock.lastCall?.[0].theme).toBe("nord");
      await vi.advanceTimersByTimeAsync(2000);
      expect(write).toHaveBeenCalledTimes(4);
    } finally {
      persistence.destroy();
      measure.mockRestore();
      view.destroy();
    }
  });
});
