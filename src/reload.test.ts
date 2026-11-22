import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isDirty, markSaved, savedDocument, statusMessage } from "./document";
import { onDocChangedOnDisk } from "./fsapi";
import { reloadExtension } from "./reload";

vi.mock("./fsapi", () => ({ onDocChangedOnDisk: vi.fn() }));

describe("disk reload", () => {
  let view: EditorView;
  let parent: HTMLDivElement;
  let notify: (content: string) => void;
  let unlisten: ReturnType<typeof vi.fn<() => void>>;

  beforeEach(() => {
    Object.defineProperties(Range.prototype, {
      getClientRects: { configurable: true, value: () => [] },
      getBoundingClientRect: { configurable: true, value: () => new DOMRect() },
    });
    parent = document.createElement("div");
    document.body.append(parent);
    unlisten = vi.fn();
    vi.mocked(onDocChangedOnDisk).mockImplementation((listener) => {
      notify = listener;
      return Promise.resolve(unlisten);
    });
  });

  afterEach(() => {
    view?.destroy();
    parent.remove();
    vi.restoreAllMocks();
  });

  function create(): void {
    view = new EditorView({
      parent,
      state: EditorState.create({
        doc: "original text",
        extensions: [savedDocument, statusMessage, EditorState.allowMultipleSelections.of(true), reloadExtension()],
      }),
    });
  }

  function edit(): void {
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: "my changes" } });
  }

  function click(label: string): void {
    const button = [...parent.querySelectorAll("button")].find((button) => button.textContent === label);
    if (!button) throw new Error(`Missing ${label} button`);
    button.click();
  }

  it("replaces clean buffers and preserves selections with positions clamped", () => {
    create();
    view.dispatch({ selection: EditorSelection.create([
      EditorSelection.range(3, 1), EditorSelection.cursor(12),
    ], 1) });
    notify("short");
    expect(view.state.doc.toString()).toBe("short");
    expect(isDirty(view.state)).toBe(false);
    expect(view.state.selection.ranges.map(({ anchor, head }) => [anchor, head])).toEqual([[3, 1], [5, 5]]);
    expect(view.state.selection.mainIndex).toBe(1);
    expect(parent.querySelector(".mdw-reload")).toBeNull();
    notify("");
    expect(view.state.selection.main.head).toBe(0);
    expect(isDirty(view.state)).toBe(false);
  });

  it("leaves dirty buffers editable and reloads the latest disk content on request", () => {
    create();
    edit();
    view.dispatch({ selection: { anchor: 9 } });
    view.focus();
    notify("disk version");
    expect(document.activeElement).toBe(view.contentDOM);
    expect(view.state.doc.toString()).toBe("my changes");
    expect(parent.querySelector(".mdw-reload")?.textContent).toContain("File changed on disk — ReloadKeep mine");
    view.dispatch({ changes: { from: view.state.doc.length, insert: " and more" } });
    notify("latest");
    click("Reload");
    expect(view.state.doc.toString()).toBe("latest");
    expect(view.state.selection.main.head).toBe(6);
    expect(isDirty(view.state)).toBe(false);
    expect(parent.querySelector(".mdw-reload")).toBeNull();
  });

  it("Keep mine dismisses the banner and retains edits against the disk baseline", () => {
    create();
    edit();
    notify("disk version");
    click("Keep mine");
    expect(view.state.doc.toString()).toBe("my changes");
    expect(isDirty(view.state)).toBe(true);
    expect(view.state.field(savedDocument).toString()).toBe("disk version");
    expect(parent.querySelector(".mdw-reload")).toBeNull();
    notify("another version");
    expect(parent.querySelector(".mdw-reload")).not.toBeNull();
  });

  it("clears obsolete reload prompts after a successful save", () => {
    create();
    edit();
    notify("disk version");
    view.dispatch({ effects: markSaved.of(view.state.doc) });
    expect(parent.querySelector(".mdw-reload")).toBeNull();
    expect(isDirty(view.state)).toBe(false);
  });

  it("removes the event listener when the editor is destroyed", async () => {
    create();
    await Promise.resolve();
    view.destroy();
    expect(unlisten).toHaveBeenCalledOnce();
    notify("late event");
    expect(view.state.doc.toString()).toBe("original text");
  });

  it("removes a listener whose registration completes after destruction", async () => {
    let finish: (unlisten: () => void) => void = () => {};
    vi.mocked(onDocChangedOnDisk).mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    create();
    view.destroy();
    finish(unlisten);
    await Promise.resolve();
    expect(unlisten).toHaveBeenCalledOnce();
  });
});
