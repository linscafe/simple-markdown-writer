import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { PhysicalPosition } from "@tauri-apps/api/dpi";
import type { DragDropEvent } from "@tauri-apps/api/webviewWindow";
import { open } from "@tauri-apps/plugin-dialog";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { imageInsertionExtension } from "./images";
import { saveImageBytes, saveImageFile } from "../fsapi";
import { statusMessage } from "../document";

const native = vi.hoisted(() => ({ listen: vi.fn<(handler: (event: { payload: DragDropEvent }) => void) => Promise<() => void>>(async () => () => {}) }));
vi.mock("@tauri-apps/api/webviewWindow", () => ({ getCurrentWebviewWindow: () => ({ onDragDropEvent: native.listen }) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
vi.mock("../fsapi", () => ({ saveImageBytes: vi.fn(), saveImageFile: vi.fn() }));

describe("image insertion", () => {
  let view: EditorView;
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} });
    Object.defineProperties(Range.prototype, {
      getClientRects: { configurable: true, value: () => [] },
      getBoundingClientRect: { configurable: true, value: () => new DOMRect() },
    });
    view = new EditorView({ state: EditorState.create({ doc: "hello world", selection: { anchor: 5 },
      extensions: [statusMessage, imageInsertionExtension({ path: "/notes/a.md", dir: "/notes", save: async () => {}, quit() {} })] }) });
    vi.mocked(saveImageBytes).mockResolvedValue("a.assets/image.png");
    vi.mocked(saveImageFile).mockImplementation(async (_doc, src, copy) => (copy ? "a.assets/" : "../") + src.split("/").pop());
  });
  afterEach(() => {
    view.destroy();
    Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
    vi.restoreAllMocks();
  });
  function paste() {
    const file = new File([new Uint8Array([1, 2])], "image.png", { type: "image/png" });
    Object.defineProperty(file, "arrayBuffer", { value: async () => new Uint8Array([1, 2]).buffer });
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", { value: { items: [{ type: "image/png", getAsFile: () => file }] } });
    view.contentDOM.dispatchEvent(event);
    return event;
  }
  async function drop(paths: string[]) {
    vi.spyOn(view, "posAtCoords").mockReturnValue(0);
    await vi.waitFor(() => expect(native.listen).toHaveBeenCalled());
    native.listen.mock.calls.at(-1)?.[0]({ payload: { type: "drop", paths, position: new PhysicalPosition(10, 20) } });
  }
  it("saves clipboard bytes and inserts inline at the mapped cursor", async () => {
    let finish: (value: string) => void = () => {};
    vi.mocked(saveImageBytes).mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    expect(paste().defaultPrevented).toBe(true);
    expect(view.state.field(statusMessage)).toBe("Saving image…");
    view.dispatch({ changes: { from: 0, insert: "start " } });
    await vi.waitFor(() => expect(saveImageBytes).toHaveBeenCalledWith("/notes/a.md", new Uint8Array([1, 2]), "png", undefined));
    finish("a.assets/image.png");
    await vi.waitFor(() => expect(view.state.doc.toString()).toBe("start hello![](a.assets/image.png) world"));
    expect(view.state.field(statusMessage)).toBe("");
  });
  it("inserts multiple native drops in order and links non-images without copying", async () => {
    await drop(["/pics/a.png", "/files/b.pdf"]);
    await vi.waitFor(() => expect(view.state.doc.toString()).toBe("![](a.assets/a.png)\n[b.pdf](../b.pdf)hello world"));
    expect(saveImageFile).toHaveBeenNthCalledWith(1, "/notes/a.md", "/pics/a.png", true, undefined);
    expect(saveImageFile).toHaveBeenNthCalledWith(2, "/notes/a.md", "/files/b.pdf", false, undefined);
  });
  it("links images without copying when Shift is held", async () => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Shift", shiftKey: true }));
    await drop(["/pics/a.webp"]);
    await vi.waitFor(() => expect(saveImageFile).toHaveBeenCalledWith("/notes/a.md", "/pics/a.webp", false, undefined));
    await vi.waitFor(() => expect(view.state.doc.toString()).toContain("![](../a.webp)"));
  });
  it("uses the image dialog with Ctrl+Shift+I", async () => {
    vi.mocked(open).mockResolvedValue(["/pics/a.png"]);
    view.contentDOM.dispatchEvent(new KeyboardEvent("keydown", { key: "I", code: "KeyI", keyCode: 73, ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(view.state.doc.toString()).toBe("hello![](a.assets/a.png) world"));
    expect(open).toHaveBeenCalledWith(expect.objectContaining({ multiple: true }));
  });
  it("cancels insertion when the editor state is replaced during saving", async () => {
    let finish: (value: string) => void = () => {};
    vi.mocked(saveImageBytes).mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    paste();
    await vi.waitFor(() => expect(saveImageBytes).toHaveBeenCalled());
    view.setState(EditorState.create({ doc: "another document", extensions: [statusMessage] }));
    finish("a.assets/image.png");
    await Promise.resolve();
    expect(view.state.doc.toString()).toBe("another document");
  });
});
