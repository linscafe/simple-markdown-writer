import { EditorSelection, StateEffect, StateField, Transaction, type Extension } from "@codemirror/state";
import { EditorView, showPanel, ViewPlugin, type Panel } from "@codemirror/view";
import { isDirty, markSaved, showMessage } from "./document";
import { onDocChangedOnDisk } from "./fsapi";
import type { EditorContext } from "./extensions";

const setDiskContent = StateEffect.define<string | null>();
const diskContent = StateField.define<string | null>({
  create: () => null,
  update: (content, transaction) => {
    for (const effect of transaction.effects) {
      if (effect.is(markSaved)) content = null;
      if (effect.is(setDiskContent)) content = effect.value;
    }
    return content;
  },
  provide: (field) => showPanel.from(field, (content) => content === null ? null : reloadPanel),
});

function replaceFromDisk(view: EditorView, content: string): void {
  const doc = view.state.toText(content);
  const selection = EditorSelection.create(view.state.selection.ranges.map((range) =>
    EditorSelection.range(Math.min(range.anchor, doc.length), Math.min(range.head, doc.length)),
  ), view.state.selection.mainIndex);
  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: doc },
    selection,
    effects: [markSaved.of(doc), setDiskContent.of(null)],
    annotations: Transaction.addToHistory.of(false),
  });
}

function reloadPanel(view: EditorView): Panel {
  const dom = document.createElement("div");
  dom.className = "mdw-reload";
  dom.setAttribute("role", "status");
  dom.append("File changed on disk — ");
  const reload = document.createElement("button");
  reload.type = "button";
  reload.textContent = "Reload";
  reload.addEventListener("click", () => {
    const content = view.state.field(diskContent);
    if (content !== null) replaceFromDisk(view, content);
    view.focus();
  });
  const keep = document.createElement("button");
  keep.type = "button";
  keep.textContent = "Keep mine";
  keep.addEventListener("click", () => {
    const content = view.state.field(diskContent);
    if (content !== null) {
      view.dispatch({ effects: [markSaved.of(view.state.toText(content)), setDiskContent.of(null)] });
    }
    view.focus();
  });
  dom.append(reload, keep);
  return { dom, top: true };
}

export function reloadExtension(context?: EditorContext): Extension {
  return [
    diskContent,
    ViewPlugin.fromClass(class {
      private destroyed = false;
      private unlisten?: () => void;

      constructor(view: EditorView) {
        void onDocChangedOnDisk((content) => {
          if (this.destroyed) return;
          if (isDirty(view.state)) {
            view.dispatch({ effects: setDiskContent.of(content) });
          } else {
            replaceFromDisk(view, content);
          }
        }, context ? () => context.path : undefined).then((unlisten) => {
          if (this.destroyed) unlisten();
          else this.unlisten = unlisten;
        }).catch((error: unknown) => {
          if (!this.destroyed) {
            view.dispatch({ effects: showMessage.of(`Cannot watch document: ${String(error)}`) });
          }
        });
      }

      destroy(): void {
        this.destroyed = true;
        this.unlisten?.();
      }
    }),
    EditorView.baseTheme({
      ".mdw-reload": { padding: "8px 16px", color: "var(--fg)", background: "var(--bg)" },
      ".mdw-reload button": {
        marginLeft: "8px", font: "inherit", color: "var(--accent)", background: "var(--bg)",
        border: "1px solid var(--muted)", borderRadius: "3px", cursor: "pointer",
      },
    }),
  ];
}
