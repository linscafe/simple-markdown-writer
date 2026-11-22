import type { Extension } from "@codemirror/state";
import { EditorView, ViewPlugin, keymap, type ViewUpdate } from "@codemirror/view";
import { Prec } from "@codemirror/state";
import type { EditorContext } from "../extensions";
import { saveImageBytes, saveImageFile } from "../fsapi";
import { showMessage } from "../document";
import { registerEx } from "../vim";

const imageExtension = /\.(?:png|jpe?g|gif|webp|svg|bmp|avif|ico)$/i;
const imageTypes: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" };
const handlers = new WeakMap<EditorView, ImageInsertion>();
interface PendingInsertion { from: number; to: number }

class ImageInsertion {
  private destroyed = false;
  private unlisten?: () => void;
  private shiftHeld = false;
  private pending = new Set<PendingInsertion>();
  private key = (event: KeyboardEvent) => { this.shiftHeld = event.shiftKey; };
  private blur = () => { this.shiftHeld = false; };

  constructor(private view: EditorView, private context: EditorContext) {
    handlers.set(view, this);
    window.addEventListener("keydown", this.key, true);
    window.addEventListener("keyup", this.key, true);
    window.addEventListener("blur", this.blur);
    if ("__TAURI_INTERNALS__" in window) void this.listenForDrops();
  }

  private async listenForDrops(): Promise<void> {
    try {
      const { getCurrentWebviewWindow } = await import("@tauri-apps/api/webviewWindow");
      if (this.destroyed) return;
      const unlisten = await getCurrentWebviewWindow().onDragDropEvent(({ payload }) => {
        const view = this.view;
        if (payload.type !== "drop" || this.destroyed || view.state.readOnly) return;
        const scale = window.devicePixelRatio || 1;
        const pos = view.posAtCoords({ x: payload.position.x / scale, y: payload.position.y / scale })
          ?? view.state.selection.main.head;
        void this.files(payload.paths, { from: pos, to: pos }, this.shiftHeld);
      });
      if (this.destroyed) unlisten();
      else this.unlisten = unlisten;
    } catch (error) {
      this.message(`Cannot receive file drops: ${String(error)}`);
    }
  }

  private message(text: string): void {
    if (!this.destroyed) this.view.dispatch({ effects: showMessage.of(text) });
  }

  private async insert(range: PendingInsertion, save: () => Promise<string>): Promise<void> {
    if (this.destroyed || this.view.state.readOnly) return;
    this.pending.add(range);
    this.message("Saving image…");
    try {
      const text = await save();
      if (this.destroyed) return;
      this.view.dispatch({
        changes: { from: range.from, to: range.to, insert: text },
        selection: { anchor: range.from + text.length },
        effects: showMessage.of(this.pending.size > 1 ? "Saving image…" : ""),
        userEvent: "input.paste", scrollIntoView: true,
      });
    } catch (error) {
      this.message(`Cannot insert file: ${String(error)}`);
    } finally {
      this.pending.delete(range);
    }
  }

  paste(files: File[]): void {
    const { from, to } = this.view.state.selection.main;
    const docPath = this.context.path;
    const pattern = this.context.config?.image_dir;
    void this.insert({ from, to }, async () => {
      const links: string[] = [];
      for (const file of files) {
        const bytes = new Uint8Array(await file.arrayBuffer());
        links.push(`![](${await saveImageBytes(docPath, bytes, imageTypes[file.type], pattern)})`);
      }
      return links.join("\n");
    });
  }

  private files(paths: string[], range: PendingInsertion, shift: boolean): Promise<void> {
    const docPath = this.context.path;
    const pattern = this.context.config?.image_dir;
    const copy = this.context.config?.copy_images !== false && !shift;
    return this.insert(range, async () => {
      const links: string[] = [];
      for (const path of paths) {
        const image = imageExtension.test(path);
        const relative = await saveImageFile(docPath, path, image && copy, pattern);
        const name = (path.split(/[\\/]/).pop() ?? path).replace(/[\\[\]]/g, "\\$&");
        links.push(image ? `![](${relative})` : `[${name}](${relative})`);
      }
      return links.join("\n");
    });
  }

  async pick(): Promise<void> {
    const range = { from: this.view.state.selection.main.from, to: this.view.state.selection.main.to };
    this.pending.add(range);
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const paths = await open({ multiple: true, filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "avif", "ico"] }] });
      if (paths && !this.destroyed) await this.files(Array.isArray(paths) ? paths : [paths], range, false);
    } catch (error) {
      this.message(`Cannot choose image: ${String(error)}`);
    } finally {
      this.pending.delete(range);
    }
  }

  update(update: ViewUpdate): void {
    if (!update.docChanged) return;
    for (const range of this.pending) {
      range.from = update.changes.mapPos(range.from, 1);
      range.to = update.changes.mapPos(range.to, 1);
    }
  }

  destroy(): void {
    this.destroyed = true;
    handlers.delete(this.view);
    this.unlisten?.();
    window.removeEventListener("keydown", this.key, true);
    window.removeEventListener("keyup", this.key, true);
    window.removeEventListener("blur", this.blur);
  }
}

registerEx("img", "img", (cm) => { void handlers.get(cm.cm6 as EditorView)?.pick(); });

export function imageInsertionExtension(context: EditorContext): Extension {
  return [
    ViewPlugin.define((view) => new ImageInsertion(view, context)),
    EditorView.domEventHandlers({
      paste(event, view) {
        if (!event.clipboardData || view.state.readOnly) return false;
        const files = Array.from(event.clipboardData.items)
          .filter((item) => imageTypes[item.type]).map((item) => item.getAsFile())
          .filter((file): file is File => file !== null);
        if (!files.length) return false;
        event.preventDefault();
        handlers.get(view)?.paste(files);
        return true;
      },
      drop(event) {
        if (!event.dataTransfer?.files.length) return false;
        event.preventDefault();
        return true;
      },
    }),
    Prec.highest(keymap.of([{ key: "Ctrl-Shift-i", run: (view) => { void handlers.get(view)?.pick(); return true; } }])),
  ];
}
