import { undo } from "@codemirror/commands";
import type { EditorView } from "@codemirror/view";
import { getCM, Vim } from "@replit/codemirror-vim";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEditor } from "./editor";
import { isDirty } from "./document";

vi.mock("./fsapi", () => ({ onDocChangedOnDisk: vi.fn(async () => () => {}) }));

describe("editor commands", () => {
  let view: EditorView;
  let parent: HTMLDivElement;
  let writeFile: ReturnType<typeof vi.fn<(path: string, content: string) => Promise<void>>>;
  let quit: ReturnType<typeof vi.fn<() => void>>;

  beforeEach(() => {
    Object.defineProperties(Range.prototype, {
      getClientRects: { configurable: true, value: () => [] },
      getBoundingClientRect: { configurable: true, value: () => new DOMRect() },
    });
    parent = document.createElement("div");
    document.body.append(parent);
    writeFile = vi.fn(async () => {});
    quit = vi.fn();
    view = createEditor({
      parent,
      path: "/tmp/note.md",
      dir: "/tmp",
      content: "original",
      writeFile,
      quit,
    });
  });

  afterEach(() => {
    view?.destroy();
    parent?.remove();
    vi.restoreAllMocks();
  });

  function vimEditor(): Parameters<typeof Vim.handleEx>[0] {
    const cm = getCM(view);
    if (!cm?.state.vim) throw new Error("Vim was not initialized");
    return cm as Parameters<typeof Vim.handleEx>[0];
  }

  function ex(command: string): void {
    Vim.handleEx(vimEditor(), command);
  }

  function edit(): void {
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: "updated" } });
  }

  it("guards dirty quit, supports forced quit, and clears dirty on undo", () => {
    ex("q");
    expect(quit).toHaveBeenCalledTimes(1);
    quit.mockClear();
    edit();
    expect(parent.textContent).toContain("note.md [+]");
    ex("q");
    expect(quit).not.toHaveBeenCalled();
    expect(parent.textContent).toContain("Unsaved changes");
    ex("q!");
    expect(quit).toHaveBeenCalledTimes(1);
    undo(view);
    expect(isDirty(view.state)).toBe(false);
  });

  it.each(["w", "wq", "x"])(":%s saves the current document", async (command) => {
    edit();
    ex(command);
    await vi.waitFor(() => expect(isDirty(view.state)).toBe(false));
    expect(writeFile).toHaveBeenCalledWith("/tmp/note.md", "updated");
    expect(quit).toHaveBeenCalledTimes(command === "w" ? 0 : 1);
    expect(parent.textContent).not.toContain("[+]");
  });

  it(":x quits without rewriting a clean file", () => {
    ex("x");
    expect(writeFile).not.toHaveBeenCalled();
    expect(quit).toHaveBeenCalledOnce();
  });

  it("keeps the editor open and dirty after a failed write", async () => {
    writeFile.mockRejectedValue(new Error("Disk is full"));
    edit();
    ex("wq");
    await vi.waitFor(() => expect(parent.textContent).toContain("Save failed"));
    expect(parent.textContent).toContain("Disk is full");
    expect(isDirty(view.state)).toBe(true);
    expect(quit).not.toHaveBeenCalled();
  });

  it("preserves changes made during a pending save and refuses to quit", async () => {
    let finish: () => void = () => {};
    writeFile.mockReturnValue(new Promise<void>((resolve) => { finish = resolve; }));
    edit();
    ex("wq");
    await vi.waitFor(() => expect(writeFile).toHaveBeenCalledOnce());
    view.dispatch({ changes: { from: view.state.doc.length, insert: " later" } });
    finish();
    await vi.waitFor(() => expect(parent.textContent).toContain("Unsaved changes"));
    expect(isDirty(view.state)).toBe(true);
    expect(quit).not.toHaveBeenCalled();
  });

  it("saves with Ctrl+S and reports Vim mode changes", async () => {
    edit();
    view.contentDOM.dispatchEvent(new KeyboardEvent("keydown", {
      key: "s", code: "KeyS", ctrlKey: true, bubbles: true, cancelable: true,
    }));
    await vi.waitFor(() => expect(writeFile).toHaveBeenCalledOnce());
    const cm = vimEditor();
    Vim.handleKey(cm, "i", "test");
    expect(parent.querySelector(".mdw-status")?.textContent).toContain("INSERT");
    Vim.handleKey(cm, "<Esc>", "test");
    Vim.handleKey(cm, "v", "test");
    expect(parent.querySelector(".mdw-status")?.textContent).toContain("VISUAL");
  });
});
