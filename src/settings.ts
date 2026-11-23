import { StateEffect } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { showMessage } from "./document";

export interface UserConfig {
  theme: string;
  font_body: string | null;
  font_mono: string | null;
  font_size: number;
  line_width: number;
  vim: boolean;
  vim_maps: { lhs: string; rhs: string; mode: string }[];
  image_dir: string;
  copy_images: boolean;
  keymap: { zoom_in: string[]; zoom_out: string[]; zoom_reset: string[] };
  warning: string | null;
}

export interface FileState {
  cursor: number;
  scroll_top: number;
  last_used: number;
}

export interface AppState {
  theme: string | null;
  window: { w: number; h: number; x: number; y: number; maximized: boolean } | null;
  files: Record<string, FileState>;
  background?: string | null;
  zoom?: number;
  toc?: boolean;
}

export function applyConfig(config: UserConfig): void {
  const style = document.documentElement.style;
  const fonts: [string, string | null][] = [["--font-body", config.font_body], ["--font-mono", config.font_mono]];
  for (const [property, value] of fonts) {
    if (value) style.setProperty(property, value);
    else style.removeProperty(property);
  }
  style.setProperty("--font-size", `${config.font_size}px`);
  style.setProperty("--line-width", `${config.line_width}px`);
}

export function persistEditorState(
  view: EditorView,
  path: string,
  state: AppState,
  write: (state: AppState, themeChanged: boolean) => Promise<void>,
): { flush(): Promise<void>; destroy(): void; restored: Promise<void> } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending = Promise.resolve();
  let restoring = true;
  let destroyed = false;
  const savedScroll = state.files[path]?.scroll_top ?? 0;
  let finishRestore: () => void = () => {};
  const restored = new Promise<void>((resolve) => { finishRestore = resolve; });
  view.requestMeasure({
    read: () => Math.max(0, savedScroll),
    write: (scrollTop) => {
      if (!destroyed) view.scrollDOM.scrollTop = scrollTop;
      restoring = false;
      finishRestore();
    },
  });

  function flush(themeChanged = false): Promise<void> {
    clearTimeout(timer);
    timer = undefined;
    state.files[path] = {
      cursor: view.state.selection.main.head,
      scroll_top: restoring ? savedScroll : view.scrollDOM.scrollTop,
      last_used: Math.max(Date.now(), ...Object.values(state.files).map((entry) => entry.last_used + 1)),
    };
    state.background = getComputedStyle(document.documentElement).getPropertyValue("--bg").trim() || null;
    const snapshot = structuredClone(state);
    pending = pending.catch(() => {}).then(() => write(snapshot, themeChanged));
    return pending;
  }
  function schedule(): void {
    if (restoring || destroyed) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      void flush().catch((error: unknown) => {
        view.dispatch({ effects: showMessage.of(`Cannot save editor state: ${String(error)}`) });
      });
    }, 2000);
  }
  function themeChanged(event: Event): void {
    state.theme = (event as CustomEvent<string>).detail;
    void flush(true).catch((error: unknown) => {
      view.dispatch({ effects: showMessage.of(`Cannot save theme: ${String(error)}`) });
    });
  }
  view.dispatch({ effects: StateEffect.appendConfig.of(EditorView.updateListener.of((update) => {
    if (update.selectionSet || update.docChanged) schedule();
  })) });
  view.scrollDOM.addEventListener("scroll", schedule);
  document.addEventListener("mdw-theme-change", themeChanged);
  return {
    flush,
    restored,
    destroy: () => {
      destroyed = true;
      clearTimeout(timer);
      finishRestore();
      view.scrollDOM.removeEventListener("scroll", schedule);
      document.removeEventListener("mdw-theme-change", themeChanged);
    },
  };
}
