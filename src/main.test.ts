import { EditorView } from "@codemirror/view";
import { Vim, getCM, type CodeMirrorV } from "@replit/codemirror-vim";
import { invoke } from "@tauri-apps/api/core";
import { listen, type Event, type EventCallback } from "@tauri-apps/api/event";
import { expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ label: "doc-2" }) }));

it("keeps the spare hidden until assigned, checks live dirty state, and closes its own window on :q", async () => {
  Object.defineProperties(Range.prototype, {
    getClientRects: { configurable: true, value: () => [] },
    getBoundingClientRect: { configurable: true, value: () => new DOMRect() },
  });
  document.body.innerHTML = '<main id="editor"></main>';
  const handlers = new Map<string, EventCallback<unknown>>();
  vi.mocked(listen).mockImplementation(async (name, handler, options) => {
    expect(options?.target).toBe("doc-2");
    handlers.set(name, handler);
    return () => { handlers.delete(name); };
  });
  function emit(name: string, payload: unknown): void {
    const callback = handlers.get(name);
    if (!callback) throw new Error(`Missing listener for ${name}`);
    callback({ event: name, id: 1, payload } satisfies Event<unknown>);
  }

  vi.mocked(invoke).mockResolvedValue(null);
  await import("./main");
  await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith("get_initial_session", { listening: true }));
  expect(document.querySelector(".cm-editor")).toBeNull();
  expect(invoke).not.toHaveBeenCalledWith("show_window");
  emit("mdw-assign", {
    doc: { path: "/notes/new.md", content: "sample" },
    state: { files: {}, theme: null, window: null },
    config: { theme: "nord", vim: true, vim_maps: [], font_size: 18, line_width: 760 },
    themes: [], timing: true,
  });
  await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith("finish_startup", {
    ready: true,
    marks: expect.arrayContaining([["[js] first frame", expect.any(Number)]]),
  }));
  expect(document.documentElement.dataset.theme).toBe("nord");
  expect(invoke).toHaveBeenCalledWith("show_window");
  const view = EditorView.findFromDOM(document.querySelector(".cm-editor")!);
  if (!view) throw new Error("Editor missing");
  try {
    expect(view.state.doc.toString()).toBe("sample");
    view.dispatch({ changes: { from: 0, insert: "x" } });
    emit("mdw-prepare-stop", 3);
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith("stop_result", { id: 3, dirty: true, error: undefined }));
    expect(document.body.inert).toBe(true);
    emit("mdw-cancel-stop", 3);
    expect(document.body.inert).toBe(false);
    view.dispatch({ changes: { from: 0, to: 1 } });
    const cm = getCM(view);
    if (!cm?.state.vim) throw new Error("Vim missing");
    Vim.handleEx(cm as CodeMirrorV, "q");
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith("close_window"));
    expect(invoke).not.toHaveBeenCalledWith("quit_app");
  } finally {
    view.destroy();
  }
});
