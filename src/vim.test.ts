import { EditorSelection } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { invoke } from "@tauri-apps/api/core";
import { getCM, Vim, type CodeMirrorV } from "@replit/codemirror-vim";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEditor } from "./editor";
import { isDirty, statusMessage } from "./document";
import { applyVimMappings, registerEx } from "./vim";
import { readText, writeText } from "./clipboard";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("./window-events", () => ({ listenWindow: async () => () => {} }));
vi.mock("./clipboard", () => ({ readText: vi.fn(), writeText: vi.fn() }));

describe("Vim integration", () => {
  let view: EditorView;
  let parent: HTMLDivElement;
  let writeFile: ReturnType<typeof vi.fn<(path: string, content: string) => Promise<void>>>;
  let quit: ReturnType<typeof vi.fn<() => void>>;

  beforeEach(() => {
    Object.defineProperties(Range.prototype, {
      getClientRects: { configurable: true, value: () => [] },
      getBoundingClientRect: { configurable: true, value: () => new DOMRect() },
    });
    vi.mocked(readText).mockReset().mockResolvedValue("clipboard text");
    vi.mocked(writeText).mockReset().mockResolvedValue();
    vi.mocked(invoke).mockReset();
    parent = document.createElement("div");
    document.body.append(parent);
    writeFile = vi.fn(async () => {});
    quit = vi.fn();
    view = createEditor({
      parent, path: "/tmp/note.md", dir: "/tmp", content: "alpha\nbeta\ngamma",
      writeFile, quit,
    });
  });

  afterEach(() => {
    view.destroy();
    parent.remove();
    vi.restoreAllMocks();
  });

  function cm(): CodeMirrorV {
    const editor = getCM(view);
    if (!editor?.state.vim) throw new Error("Vim is disabled");
    return editor as CodeMirrorV;
  }

  function ex(command: string): void { Vim.handleEx(cm(), command); }
  function keys(...input: string[]): void {
    for (const key of input) Vim.handleKey(cm(), key, "test");
  }
  function toggle(): void {
    view.contentDOM.dispatchEvent(new KeyboardEvent("keydown", {
      key: "v", code: "KeyV", ctrlKey: true, altKey: true, bubbles: true, cancelable: true,
    }));
  }

  it("registers an external ex command that Vim.handleEx can invoke", () => {
    const handler = vi.fn();
    registerEx("taskthree", "taskt", handler);
    ex("taskt example");
    expect(handler).toHaveBeenCalledWith(cm(), expect.objectContaining({ args: ["example"] }));
  });

  it(":w! saves and :q! discards dirty changes", async () => {
    view.dispatch({ changes: { from: 0, insert: "changed " } });
    ex("w!");
    await vi.waitFor(() => expect(writeFile).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(isDirty(view.state)).toBe(false));
    view.dispatch({ changes: { from: 0, insert: "more " } });
    ex("q!");
    expect(quit).toHaveBeenCalledOnce();
  });

  it(":e! reloads from disk and marks the reloaded snapshot saved", async () => {
    vi.mocked(invoke).mockResolvedValue("from disk");
    view.dispatch({ changes: { from: 0, insert: "unsaved " } });
    ex("e!");
    await vi.waitFor(() => expect(view.state.doc.toString()).toBe("from disk"));
    expect(invoke).toHaveBeenCalledWith("read_file", { path: "/tmp/note.md" });
    expect(isDirty(view.state)).toBe(false);
    expect(view.state.field(statusMessage)).toBe("Reloaded");
  });

  it("guards :e without ! and reports reload failures", async () => {
    view.dispatch({ changes: { from: 0, insert: "unsaved " } });
    ex("e");
    expect(invoke).not.toHaveBeenCalled();
    expect(view.state.field(statusMessage)).toContain(":e!");
    vi.mocked(invoke).mockRejectedValue(new Error("read denied"));
    ex("e!");
    await vi.waitFor(() => expect(view.state.field(statusMessage)).toContain("read denied"));
    expect(view.state.doc.toString()).toContain("unsaved");
    expect(isDirty(view.state)).toBe(true);
  });

  it("preserves edits made while a reload is pending", async () => {
    let finish: (content: string) => void = () => {};
    vi.mocked(invoke).mockReturnValue(new Promise<string>((resolve) => { finish = resolve; }));
    ex("e!");
    view.dispatch({ changes: { from: 0, insert: "later " } });
    finish("disk");
    await vi.waitFor(() => expect(view.state.field(statusMessage)).toContain("Reload cancelled"));
    expect(view.state.doc.toString()).toContain("later");
  });

  it("reconfigures wrapping and line numbers without resetting the document", () => {
    const original = view.state.doc;
    expect(view.contentDOM.classList.contains("cm-lineWrapping")).toBe(true);
    expect(parent.querySelector(".cm-lineNumbers")).toBeNull();
    ex("set nowrap");
    expect(view.contentDOM.classList.contains("cm-lineWrapping")).toBe(false);
    ex("set nu");
    expect(parent.querySelector(".cm-lineNumbers")).not.toBeNull();
    ex("set wrap");
    expect(view.contentDOM.classList.contains("cm-lineWrapping")).toBe(true);
    ex("set nonu");
    expect(parent.querySelector(".cm-lineNumbers")).toBeNull();
    expect(view.state.doc).toBe(original);
  });

  it("uses visual-line motions for j and k", () => {
    const motion = vi.spyOn(cm(), "findPosV").mockReturnValue({ line: 0, ch: 3 });
    keys("j");
    expect(motion).toHaveBeenCalledWith(expect.anything(), 1, "line", expect.anything());
    expect(view.state.selection.main.head).toBe(3);
    motion.mockReturnValue({ line: 0, ch: 0 });
    keys("k");
    expect(motion).toHaveBeenLastCalledWith(expect.anything(), -1, "line", expect.anything());
  });

  it("leaves jj unmapped by default and accepts insert mappings from config", () => {
    keys("i", "j", "j");
    expect(cm().state.vim.insertMode).toBe(true);
    keys("<Esc>");
    applyVimMappings([{ lhs: "jj", rhs: "<Esc>", mode: "i" }]);
    try {
      keys("i", "j", "j");
      expect(cm().state.vim.insertMode).toBe(false);
    } finally {
      Vim.unmap("jj", "insert");
    }
  });

  it(":novim and Ctrl+Alt+V toggle Vim and retain settings and save shortcut", async () => {
    ex("set nowrap");
    ex("set nu");
    ex("novim");
    expect(getCM(view)).toBeNull();
    expect(parent.querySelector(".mdw-status-mode")?.textContent).toBe("PLAIN");
    view.contentDOM.dispatchEvent(new KeyboardEvent("keydown", {
      key: "s", ctrlKey: true, bubbles: true, cancelable: true,
    }));
    await vi.waitFor(() => expect(writeFile).toHaveBeenCalledOnce());
    toggle();
    expect(cm().state.vim.insertMode).toBe(false);
    expect(view.contentDOM.classList.contains("cm-lineWrapping")).toBe(false);
    expect(parent.querySelector(".cm-lineNumbers")).not.toBeNull();
    keys("i");
    expect(parent.querySelector(".mdw-status-mode")?.textContent).toBe("INSERT");
    toggle();
    expect(getCM(view)).toBeNull();
  });

  it.each([{ prefix: [] }, { prefix: ['"', "+"] }])("syncs unnamed and explicit + yanks to the system clipboard (%j)", ({ prefix }) => {
    keys(...prefix, "y", "y");
    expect(writeText).toHaveBeenCalledWith("alpha\n");
    expect(Vim.getRegisterController().getRegister("+").linewise).toBe(true);
    expect(Vim.getRegisterController().getRegister().toString()).toBe("alpha\n");
  });

  it("does not overwrite the system clipboard for black-hole deletes", () => {
    keys('"', "_", "d", "d");
    expect(writeText).not.toHaveBeenCalled();
  });

  it.each([{ prefix: [] }, { prefix: ['"', "+"] }])("reads the system clipboard for unnamed and + pastes (%j)", async ({ prefix }) => {
    keys(...prefix, "p");
    await vi.waitFor(() => expect(view.state.doc.line(1).text).toBe("aclipboard textlpha"));
    expect(readText).toHaveBeenCalledOnce();
  });

  it("preserves linewise metadata for text yanked in the editor", async () => {
    keys("y", "y");
    vi.mocked(readText).mockResolvedValue("alpha\n");
    keys("p");
    await vi.waitFor(() => expect(view.state.doc.toString()).toBe("alpha\nalpha\nbeta\ngamma"));
  });

  it("preserves counts and named register pastes", async () => {
    vi.mocked(readText).mockResolvedValue("X");
    keys("2", "p");
    await vi.waitFor(() => expect(view.state.doc.line(1).text).toBe("aXXlpha"));
    Vim.getRegisterController().getRegister("a").setText("NAMED");
    vi.mocked(readText).mockClear();
    keys('"', "a", "p");
    expect(view.state.doc.line(1).text).toContain("NAMED");
    expect(readText).not.toHaveBeenCalled();
  });

  it("replaces a visual selection with clipboard text", async () => {
    vi.mocked(readText).mockResolvedValue("X");
    keys("v", "l", "p");
    await vi.waitFor(() => expect(view.state.doc.line(1).text).toBe("Xpha"));
    expect(cm().state.vim.visualMode).toBe(false);
  });

  it("reports clipboard errors without dropping the document", async () => {
    Vim.getRegisterController().getRegister().setText("INTERNAL");
    vi.mocked(readText).mockRejectedValue(new Error("permission denied"));
    keys("p");
    await vi.waitFor(() => expect(view.state.field(statusMessage)).toContain("Clipboard read failed"));
    expect(view.state.doc.line(1).text).toBe("aINTERNALlpha");
    expect(view.state.field(statusMessage)).toContain("permission denied");
    vi.mocked(writeText).mockRejectedValue(new Error("write denied"));
    keys('"', "+", "y", "y");
    await vi.waitFor(() => expect(view.state.field(statusMessage)).toContain("Clipboard write failed"));
  });

  it.each([
    { prefix: [], failure: "empty" },
    { prefix: ['"', "+"], failure: "empty" },
    { prefix: [], failure: "unavailable" },
    { prefix: ['"', "+"], failure: "unavailable" },
  ])("falls back to the unnamed register when the clipboard is $failure ($prefix)", async ({ prefix, failure }) => {
    const controller = Vim.getRegisterController();
    controller.getRegister().setText("INTERNAL");
    controller.getRegister("+").setText("STALE");
    if (failure === "empty") vi.mocked(readText).mockResolvedValue("");
    else vi.mocked(readText).mockRejectedValue(new Error("clipboard unavailable"));
    keys(...prefix, "2", "p");
    await vi.waitFor(() => expect(view.state.doc.line(1).text).toBe("aINTERNALINTERNALlpha"));
    expect(controller.getRegister().toString()).toBe("INTERNAL");
    expect(view.state.field(statusMessage)).toContain("internal unnamed register");
    expect(view.state.field(statusMessage)).toContain(failure === "empty" ? "empty" : "clipboard unavailable");
  });

  it("preserves the unnamed register's linewise metadata on clipboard failure", async () => {
    keys("y", "y");
    vi.mocked(readText).mockRejectedValue(new Error("clipboard unavailable"));
    keys('"', "+", "p");
    await vi.waitFor(() => expect(view.state.doc.toString()).toBe("alpha\nalpha\nbeta\ngamma"));
    expect(view.state.field(statusMessage)).toContain("Clipboard read failed");
  });

  it("uses the unnamed register to replace a visual selection if the clipboard is empty", async () => {
    Vim.getRegisterController().getRegister().setText("INTERNAL");
    vi.mocked(readText).mockResolvedValue("");
    keys("v", "l", "p");
    await vi.waitFor(() => expect(view.state.doc.line(1).text).toBe("INTERNALpha"));
    expect(cm().state.vim.visualMode).toBe(false);
    expect(view.state.field(statusMessage)).toContain("Clipboard is empty");
  });

  it("reports when both the system clipboard and fallback register are empty", async () => {
    Vim.getRegisterController().getRegister().setText("");
    vi.mocked(readText).mockResolvedValue("");
    keys("p");
    await vi.waitFor(() => expect(view.state.field(statusMessage)).toContain("internal unnamed register is also empty"));
    expect(view.state.doc.line(1).text).toBe("alpha");
  });

  it("does not paste into a selection changed during the clipboard read", async () => {
    let finish: (text: string) => void = () => {};
    vi.mocked(readText).mockReturnValue(new Promise<string>((resolve) => { finish = resolve; }));
    keys("p");
    view.dispatch({ selection: EditorSelection.cursor(2) });
    finish("X");
    await vi.waitFor(() => expect(view.state.field(statusMessage)).toContain("Paste cancelled"));
    expect(view.state.doc.line(1).text).toBe("alpha");
  });

  it("does not apply a fallback paste after the selection changes during a failed read", async () => {
    let fail: (error: Error) => void = () => {};
    Vim.getRegisterController().getRegister().setText("INTERNAL");
    vi.mocked(readText).mockReturnValue(new Promise<string>((_resolve, reject) => { fail = reject; }));
    keys("p");
    view.dispatch({ selection: EditorSelection.cursor(2) });
    fail(new Error("clipboard unavailable"));
    await vi.waitFor(() => expect(view.state.field(statusMessage)).toContain("Paste cancelled"));
    expect(view.state.doc.line(1).text).toBe("alpha");
  });
});
