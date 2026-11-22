import { EditorState } from "@codemirror/state";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import type { EditorView } from "@codemirror/view";
import { getCM, Vim } from "@replit/codemirror-vim";
import { invoke } from "@tauri-apps/api/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  askYesNo, assetPlan, brokenCandidates, findBroken, findLinkRefs, orphanFiles, relativePath, rewriteLinks, targetPath,
  type DocumentMove,
} from "./housekeeping";
import { createEditor } from "./editor";
import { isDirty, statusMessage } from "./document";
import type { UserConfig } from "./settings";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("./fsapi", () => ({ onDocChangedOnDisk: vi.fn(async () => () => {}), readFile: vi.fn() }));

const state = (doc: string) => EditorState.create({ doc, extensions: [markdown({ base: markdownLanguage })] });

function rewrite(doc: string, move: DocumentMove): string {
  const current = state(doc);
  return current.update({ changes: rewriteLinks(current, move) }).state.doc.toString();
}

describe("path helpers", () => {
  it("resolves targets and relative paths", () => {
    expect(targetPath("/notes", "new")).toBe("/notes/new.md");
    expect(targetPath("/notes", "../archive/old.markdown")).toBe("/archive/old.markdown");
    expect(targetPath("/notes", "/tmp/x")).toBe("/tmp/x.md");
    expect(relativePath("/a/b", "/a/c/d.png")).toBe("../c/d.png");
    expect(relativePath("/a", "/a/b/c")).toBe("b/c");
  });

  it("plans asset directory renames only for {name} patterns", () => {
    expect(assetPlan("/n/notes.md", "/n/new.md")).toEqual({
      from: "/n/notes.assets", to: "/n/new.assets", fromLabel: "notes.assets", toLabel: "new.assets",
    });
    expect(assetPlan("/n/notes.md", "/n/sub/new.md", "img/{name}")?.toLabel).toBe("sub/img/new");
    expect(assetPlan("/n/notes.md", "/n/new.md", "assets")).toBeNull();
  });
});

describe("link extraction", () => {
  it("finds local link targets with positions and skips code", () => {
    const doc = [
      "[a](a.md#x) ![i](<my img.png> \"t\") <notes.assets/b.png> <https://x.y> <a@b.c> <br> <img width=3 src='h.png'>",
      "![[e.png|200]] [[w#h|alias]] `[c](code.md)` \\[[not]]",
      "",
      "[ref]: ref.md",
      "",
      "```",
      "[f](fenced.md)",
      "```",
    ].join("\n");
    const refs = findLinkRefs(state(doc));
    expect(refs.map((ref) => [ref.kind, ref.target])).toEqual([
      ["link", "a.md#x"], ["image", "my img.png"], ["autolink", "notes.assets/b.png"], ["html", "h.png"],
      ["embed", "e.png"], ["wiki", "w#h"], ["reference", "ref.md"],
    ]);
    for (const ref of refs) expect(doc.slice(ref.from, ref.to)).toBe(ref.target);
  });

  it("reports broken-link candidates with line and column", () => {
    const doc = "# Top\n\nsee [x](missing.md) and [y](#top)\n![[pic.png]] [[other#Part]] [z](https://e.com)";
    const checks = brokenCandidates(state(doc), "/d/note.md");
    expect(checks.map(({ line, column, paths, anchor }) => ({ line, column, paths, anchor }))).toEqual([
      { line: 3, column: 5, paths: ["/d/missing.md"], anchor: "" },
      { line: 3, column: 25, paths: [], anchor: "top" },
      { line: 4, column: 1, paths: ["/d/pic.png", "/d/note.assets/pic.png"], anchor: "" },
      { line: 4, column: 14, paths: ["/d/other.md", "/d/other"], anchor: "Part" },
    ]);
  });
});

describe("link rewriting", () => {
  it("rewrites relative links for a directory move", () => {
    const doc = [
      "[n](../up.md#sec) ![i](img/a%20b.png) [s](sub/)",
      "![[notes.assets/e.png]] [[other]] <file.txt>",
      "[e](https://x.y) [h](#anchor) [abs](/etc/x) `[c](code.md)` <a@b.c> <img src='p q.png'>",
      "```", "[f](fenced.md)", "```",
    ].join("\n");
    expect(rewrite(doc, { oldDir: "/d/notes", newDir: "/d/notes/archive/2026" })).toBe([
      "[n](../../../up.md#sec) ![i](../../img/a%20b.png) [s](../../sub/)",
      "![[../../notes.assets/e.png]] [[../../other]] <../../file.txt>",
      "[e](https://x.y) [h](#anchor) [abs](/etc/x) `[c](code.md)` <a@b.c> <img src='../../p q.png'>",
      "```", "[f](fenced.md)", "```",
    ].join("\n"));
    expect(rewrite("[x](../b.md) [y](./c.md)", { oldDir: "/r/a/sub", newDir: "/r/a" })).toBe("[x](b.md) [y](sub/c.md)");
  });

  it("encodes new directory names in the link's style", () => {
    expect(rewrite("![](a%20b.png) ![](<c d.png>) ![](e.png)", { oldDir: "/x/my dir", newDir: "/x/other" }))
      .toBe("![](../my%20dir/a%20b.png) ![](<../my dir/c d.png>) ![](../my%20dir/e.png)");
  });

  it("rewrites links into a renamed asset directory", () => {
    const assets = { from: "/n/notes.assets", to: "/n/new.assets" };
    const doc = [
      "![](notes.assets/a.png) [f](./notes.assets/sub/b.pdf#page=2) <notes.assets/c.png>",
      "![[notes.assets/d.png]] ![](notes.assets) ![](other.assets/x.png) `![](notes.assets/code.png)`",
    ].join("\n");
    expect(rewrite(doc, { oldDir: "/n", newDir: "/n", assets })).toBe([
      "![](new.assets/a.png) [f](new.assets/sub/b.pdf#page=2) <new.assets/c.png>",
      "![[new.assets/d.png]] ![](new.assets) ![](other.assets/x.png) `![](notes.assets/code.png)`",
    ].join("\n"));
    expect(rewrite("![](my%20notes.assets/a%20b.png)", {
      oldDir: "/n", newDir: "/n", assets: { from: "/n/my notes.assets", to: "/n/new name.assets" },
    })).toBe("![](new%20name.assets/a%20b.png)");
    expect(rewrite("![](notes.assets/a.png) ![](img/b.png)", {
      oldDir: "/n", newDir: "/n/sub", assets: { from: "/n/notes.assets", to: "/n/sub/new.assets" },
    })).toBe("![](new.assets/a.png) ![](../img/b.png)");
  });
});

describe("orphans and broken links", () => {
  it("lists asset files not referenced by the buffer", () => {
    const doc = "![](notes.assets/a%20b.png) ![[c.png]] [p](<notes.assets/sub/d.pdf>) `![](notes.assets/e.png)`";
    expect(orphanFiles(state(doc), "/n/notes.md", "/n/notes.assets", ["a b.png", "c.png", "sub/d.pdf", "e.png", "f.png"]))
      .toEqual(["e.png", "f.png"]);
  });

  it("checks file existence in one batch and validates anchors", async () => {
    const doc = "# Top\n\n[a](#top) [b](#nope) [c](gone.png) [d](other.md#there) [e](other.md#missing) [f](pic.png#x)";
    const exists = vi.fn(async (paths: string[]) => paths.map((path) => path !== "/d/gone.png"));
    const read = vi.fn(async () => "## There\n");
    const broken = await findBroken(state(doc), "/d/note.md", { exists, read });
    expect(exists).toHaveBeenCalledTimes(1);
    expect(exists).toHaveBeenCalledWith(["/d/gone.png", "/d/other.md", "/d/pic.png"]);
    expect(read).toHaveBeenCalledTimes(1);
    expect(broken.map(({ line, column, target, reason }) => `${line}:${column} ${target} ${reason}`)).toEqual([
      "3:11 #nope missing heading", "3:22 gone.png missing file", "3:56 other.md#missing missing heading",
    ]);
  });
});

describe("ex commands", () => {
  let view: EditorView;
  let parent: HTMLDivElement;
  const fileStates = { "/n/notes.md": { cursor: 3, scroll_top: 7, last_used: 1 } };
  const documentChanged = vi.fn();

  beforeEach(() => {
    Object.defineProperties(Range.prototype, {
      getClientRects: { configurable: true, value: () => [] },
      getBoundingClientRect: { configurable: true, value: () => new DOMRect() },
    });
    vi.mocked(invoke).mockReset();
    parent = document.createElement("div");
    document.body.append(parent);
    view = createEditor({
      parent, path: "/n/notes.md", dir: "/n", content: "![](notes.assets/a.png)\n",
      fileStates, documentChanged, writeFile: vi.fn(async () => {}), quit: vi.fn(),
    });
  });

  afterEach(() => {
    view.destroy();
    parent.remove();
  });

  const ex = (command: string) => Vim.handleEx(getCM(view) as Parameters<typeof Vim.handleEx>[0], command);
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  const press = (key: string) => window.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));

  it("asks once via a key press", async () => {
    const answer = askYesNo(view, "Proceed? (y/n)");
    expect(view.state.field(statusMessage)).toBe("Proceed? (y/n)");
    press("Shift");
    press("n");
    await expect(answer).resolves.toBe(false);
    const second = askYesNo(view, "Again?");
    press("Enter");
    await expect(second).resolves.toBe(true);
  });

  it("renames into another directory, moving assets and rewriting links", async () => {
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === "paths_exist") return [true];
      if (command === "rename_document") return { path: "/n/archive/new.md", content: "" };
      throw new Error(`unexpected ${command} ${JSON.stringify(args)}`);
    });
    ex("rename archive/new");
    await settle();
    expect(view.state.field(statusMessage)).toBe("Rename notes.assets/ → archive/new.assets/ and update links? (y/n)");
    press("y");
    await settle();
    await settle();
    expect(invoke).toHaveBeenCalledWith("rename_document", { request: {
      from: "/n/notes.md", to: "/n/archive/new.md", overwrite: false, copy: false,
      content: "![](new.assets/a.png)\n", assets: { from: "/n/notes.assets", to: "/n/archive/new.assets" },
    } });
    expect(view.state.doc.toString()).toBe("![](new.assets/a.png)\n");
    expect(isDirty(view.state)).toBe(false);
    expect(view.state.field(statusMessage)).toBe("Renamed to new.md");
    expect(documentChanged).toHaveBeenCalledWith("/n/archive/new.md");
    expect(fileStates).toHaveProperty(["/n/archive/new.md", "cursor"], 3);
    expect(parent.textContent).toContain("new.md");
  });

  it("saves as with overwrite, declining the asset copy", async () => {
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "paths_exist") return [true];
      return { path: "/n/copy.md", content: "" };
    });
    ex("saveas! copy.md");
    await settle();
    press("n");
    await settle();
    await settle();
    expect(invoke).toHaveBeenLastCalledWith("rename_document", { request: {
      from: "/n/notes.md", to: "/n/copy.md", overwrite: true, copy: true,
      content: "![](notes.assets/a.png)\n", assets: null,
    } });
    expect(view.state.field(statusMessage)).toBe("Saved as copy.md");
  });

  it("reports a missing asset directory and an absence of broken links", async () => {
    vi.mocked(invoke).mockImplementation(async (command) => command === "list_files" ? null : [true]);
    ex("orphans");
    await settle();
    expect(view.state.field(statusMessage)).toBe("No asset directory");
    ex("broken");
    await settle();
    expect(view.state.field(statusMessage)).toBe("No broken links");
  });

  it("lists orphans in a panel and deletes the selected row after confirmation", async () => {
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === "list_files") return ["a.png", "b.png", "c.png"];
      if (command === "paths_exist") return (args as { paths: string[] }).paths.map(() => false);
      return undefined;
    });
    ex("orphans");
    await settle();
    const panel = parent.querySelector<HTMLElement>(".mdw-housekeeping");
    expect([...panel!.querySelectorAll("li")].map((item) => item.textContent)).toEqual(["notes.assets/b.png", "notes.assets/c.png"]);
    panel!.dispatchEvent(new KeyboardEvent("keydown", { key: "j", bubbles: true }));
    panel!.dispatchEvent(new KeyboardEvent("keydown", { key: "d", bubbles: true }));
    expect(view.state.field(statusMessage)).toBe("Delete notes.assets/c.png? (y/n)");
    press("y");
    await settle();
    expect(invoke).toHaveBeenCalledWith("delete_files", { paths: ["/n/notes.assets/c.png"] });
    expect([...parent.querySelectorAll(".mdw-housekeeping li")].map((item) => item.textContent)).toEqual(["notes.assets/b.png"]);
    parent.querySelector(".mdw-housekeeping")!.dispatchEvent(new KeyboardEvent("keydown", { key: "q", bubbles: true }));
    expect(parent.querySelector(".mdw-housekeeping")).toBeNull();
  });

  it("only lists orphans in a shared asset directory", async () => {
    view.destroy();
    view = createEditor({
      parent, path: "/n/notes.md", dir: "/n", content: "![](assets/a.png)\n",
      config: { image_dir: "assets" } as UserConfig, writeFile: vi.fn(async () => {}), quit: vi.fn(),
    });
    vi.mocked(invoke).mockImplementation(async (command) => command === "list_files" ? ["a.png", "b.png"] : undefined);
    ex("orphans!");
    await settle();
    expect(view.state.field(statusMessage)).toBe("Asset directory is shared with other documents; not deleting");
    ex("orphans");
    await settle();
    const panel = parent.querySelector<HTMLElement>(".mdw-housekeeping")!;
    expect(panel.querySelector(".mdw-housekeeping-title")?.textContent).toContain("shared directory");
    panel.dispatchEvent(new KeyboardEvent("keydown", { key: "d", bubbles: true }));
    expect(view.state.field(statusMessage)).not.toMatch(/Delete/);
    expect(invoke).not.toHaveBeenCalledWith("delete_files", expect.anything());
  });

  it("jumps to a broken link from the panel", async () => {
    view.dispatch({ changes: { from: view.state.doc.length, insert: "line [x](gone.md)" } });
    vi.mocked(invoke).mockImplementation(async (_command, args) => (args as { paths: string[] }).paths.map((path) => !path.endsWith("gone.md")));
    ex("broken");
    await settle();
    const panel = parent.querySelector<HTMLElement>(".mdw-housekeeping")!;
    expect(panel.querySelector("li")?.textContent).toBe("2:6  gone.md  (missing file)");
    panel.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(view.state.selection.main.head).toBe(view.state.doc.line(2).from + 5);
    expect(parent.querySelector(".mdw-housekeeping")).toBeNull();
  });
});
