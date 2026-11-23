import { Compartment, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { buildExtensions, type EditorContext } from "./extensions";
import { isDirty, markSaved, showMessage } from "./document";
import type { FileState, UserConfig } from "./settings";
import { openDocument } from "./fsapi";
import { isMarkdownPath, refreshMode, setSourceView } from "./mode";

interface EditorOptions {
  parent: HTMLElement;
  path: string;
  dir: string;
  content: string;
  config?: UserConfig;
  showToc?: boolean;
  cursor?: number;
  fileStates?: Record<string, FileState>;
  beforeDocumentChange?(): Promise<void>;
  documentChanged?(path: string): void;
  writeFile(path: string, content: string): Promise<void>;
  quit(): void;
}

export function parentDirectory(path: string): string {
  return path.replace(/[\\/][^\\/]*$/, "") || "/";
}

const contexts = new WeakMap<EditorView, EditorContext>();

/** Toggles plain-source display of Markdown in this editor; other files are always source. */
export function setEditorSourceView(view: EditorView, source: boolean): void {
  const context = contexts.get(view);
  if (context) setSourceView(view, context, source);
}

export function createEditor(options: EditorOptions): EditorView {
  let view: EditorView;
  let pendingSave: Promise<void> = Promise.resolve();
  const loading = new Compartment();
  let opening = false;

  const context: EditorContext = {
    path: options.path,
    dir: options.dir,
    config: options.config,
    showToc: options.showToc,
    save: () => {
      const snapshot = view.state.doc;
      const path = context.path;
      pendingSave = pendingSave.catch(() => {}).then(async () => {
        try {
          await options.writeFile(path, snapshot.toString());
          if (context.path !== path) return;
          view.dispatch({ effects: [markSaved.of(snapshot), showMessage.of("Saved")] });
        } catch (error) {
          view.dispatch({ effects: showMessage.of(`Save failed: ${String(error)}`) });
          throw error;
        }
      });
      return pendingSave;
    },
    openDocument: async (path, cursor) => {
      if (opening) return false;
      if (isDirty(view.state)) {
        view.dispatch({ effects: showMessage.of("Unsaved changes. Use :w to save before opening another document.") });
        return false;
      }
      opening = true;
      view.dispatch({ effects: loading.reconfigure([
        EditorState.readOnly.of(true), EditorView.editable.of(false),
        EditorState.transactionFilter.of((transaction) => transaction.docChanged ? [] : transaction),
      ]) });
      try {
        await pendingSave.catch(() => {});
        await options.beforeDocumentChange?.();
        const doc = await openDocument(path);
        context.path = doc.path;
        context.dir = parentDirectory(doc.path);
        const anchor = cursor ?? options.fileStates?.[doc.path]?.cursor ?? 0;
        view.setState(EditorState.create({
          doc: doc.content,
          selection: { anchor: Math.max(0, Math.min(anchor, doc.content.length)) },
          extensions,
        }));
        refreshMode(view, context);
        options.documentChanged?.(doc.path);
        view.dispatch({ effects: EditorView.scrollIntoView(view.state.selection.main.head) });
        view.focus();
        return true;
      } finally {
        opening = false;
        view.dispatch({ effects: loading.reconfigure([]) });
      }
    },
    adoptDocument: async (path) => {
      await options.beforeDocumentChange?.();
      const previous = options.fileStates?.[context.path];
      context.path = path;
      context.dir = path.replace(/[\\/][^\\/]*$/, "") || "/";
      if (previous && options.fileStates) options.fileStates[path] = { ...previous };
      refreshMode(view, context);
      options.documentChanged?.(path);
    },
    quit: options.quit,
  };

  const extensions = [...buildExtensions(context), loading.of([])];
  performance.mark("mdw:extensions built");
  const state = EditorState.create({
    doc: options.content,
    selection: { anchor: Math.max(0, Math.min(options.cursor ?? 0, options.content.length)) },
    extensions,
  });
  performance.mark("mdw:state created");
  view = new EditorView({ parent: options.parent, state });
  contexts.set(view, context);
  if (!isMarkdownPath(context.path)) refreshMode(view, context);
  performance.mark("mdw:view created");
  view.focus();
  return view;
}
