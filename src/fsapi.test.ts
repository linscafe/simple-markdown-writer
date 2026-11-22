import { invoke } from "@tauri-apps/api/core";
import { listen, type Event } from "@tauri-apps/api/event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as fsapi from "./fsapi";

vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ label: "doc-1" }) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

describe("filesystem IPC wrappers", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("sends raw typed image bytes with the document and configured directory pattern", async () => {
    vi.mocked(invoke).mockResolvedValue("assets/photo.png");
    expect(await fsapi.saveImageBytes("/notes/a.md", new Uint8Array([1, 2, 3]), "png", "assets"))
      .toBe("assets/photo.png");
    expect(invoke).toHaveBeenLastCalledWith("save_image_bytes", new Uint8Array([1, 2, 3]), {
      headers: { "x-doc-path": "%2Fnotes%2Fa.md", "x-ext": "png", "x-pattern": "assets" },
    });
    await fsapi.saveImageFile("/notes/a.md", "/pictures/a.png", false);
    expect(invoke).toHaveBeenLastCalledWith("save_image_file", {
      docPath: "/notes/a.md", srcPath: "/pictures/a.png", copy: false, pattern: "{name}.assets",
    });
  });

  it("maps filesystem arguments to the Rust command names", async () => {
    await fsapi.openDocument("/notes/other.md");
    expect(invoke).toHaveBeenLastCalledWith("open_document", { path: "/notes/other.md" });
    await fsapi.getInitialDoc();
    expect(invoke).toHaveBeenLastCalledWith("get_initial_doc");
    await fsapi.readFile("/notes/a.md");
    expect(invoke).toHaveBeenLastCalledWith("read_file", { path: "/notes/a.md" });
    await fsapi.writeFile("/notes/a.md", "text");
    expect(invoke).toHaveBeenLastCalledWith("write_file", { path: "/notes/a.md", content: "text" });
    await fsapi.listDir("/notes/a.md", "images");
    expect(invoke).toHaveBeenLastCalledWith("list_dir", { docPath: "/notes/a.md", relDir: "images" });
    await fsapi.pathExists("/notes/a.md", "images/a.png");
    expect(invoke).toHaveBeenLastCalledWith("path_exists", { docPath: "/notes/a.md", rel: "images/a.png" });
    await fsapi.openExternal("https://example.com");
    expect(invoke).toHaveBeenLastCalledWith("open_external", { url: "https://example.com" });
  });

  it("delivers disk content and exposes listener cleanup", async () => {
    const onChange = vi.fn();
    const unlisten = vi.fn();
    vi.mocked(listen).mockImplementation(async (name, handler) => {
      handler({ event: name, id: 1, payload: "new content" } as Event<unknown>);
      return unlisten;
    });
    expect(await fsapi.onDocChangedOnDisk(onChange)).toBe(unlisten);
    expect(listen).toHaveBeenCalledWith("doc-changed-on-disk", expect.any(Function), { target: "doc-1" });
    expect(onChange).toHaveBeenCalledWith("new content");
  });
  it("ignores stale watcher events from another document", async () => {
    const onChange = vi.fn();
    vi.mocked(listen).mockImplementation(async (name, handler) => {
      for (const path of ["/notes/old.md", "/notes/current.md"]) {
        handler({ event: name, id: 1, payload: { path, content: path } } as Event<unknown>);
      }
      return () => {};
    });
    await fsapi.onDocChangedOnDisk(onChange, () => "/notes/current.md");
    expect(onChange).toHaveBeenCalledExactlyOnceWith("/notes/current.md");
  });

});
