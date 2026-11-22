import { invoke } from "@tauri-apps/api/core";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { listenWindow } from "./window-events";

export interface InitialDoc {
  path: string;
  content: string;
}

export interface DirectoryEntry {
  name: string;
  is_dir: boolean;
}

export function getInitialDoc(): Promise<InitialDoc> {
  return invoke<InitialDoc>("get_initial_doc");
}

export function openDocument(path: string): Promise<InitialDoc> {
  return invoke<InitialDoc>("open_document", { path });
}

export function readFile(path: string): Promise<string> {
  return invoke<string>("read_file", { path });
}

export function writeFile(path: string, content: string): Promise<void> {
  return invoke<void>("write_file", { path, content });
}

export function saveImageBytes(
  docPath: string,
  bytes: Uint8Array | readonly number[],
  ext: string,
  pattern = "{name}.assets",
): Promise<string> {
  return invoke<string>("save_image_bytes", bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes), {
    headers: { "x-doc-path": encodeURIComponent(docPath), "x-ext": ext, "x-pattern": encodeURIComponent(pattern) },
  });
}

export function saveImageFile(
  docPath: string,
  srcPath: string,
  copy = true,
  pattern = "{name}.assets",
): Promise<string> {
  return invoke<string>("save_image_file", { docPath, srcPath, copy, pattern });
}

export function listDir(docPath: string, relDir = ""): Promise<DirectoryEntry[]> {
  return invoke<DirectoryEntry[]>("list_dir", { docPath, relDir });
}

export function pathExists(docPath: string, rel: string): Promise<boolean> {
  return invoke<boolean>("path_exists", { docPath, rel });
}

export function openExternal(url: string): Promise<void> {
  return invoke<void>("open_external", { url });
}

export function onDocChangedOnDisk(onChange: (content: string) => void, path?: () => string): Promise<UnlistenFn> {
  return listenWindow<string | InitialDoc>("doc-changed-on-disk", ({ payload }) => {
    if (typeof payload === "string") onChange(payload);
    else if (!path || payload.path === path()) onChange(payload.content);
  });
}
