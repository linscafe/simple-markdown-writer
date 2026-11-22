import type { Extension, Text } from "@codemirror/state";
import { showPanel, type Panel, type EditorView, type ViewUpdate } from "@codemirror/view";
import { getCM } from "@replit/codemirror-vim";
import { isDirty, statusMessage } from "./document";
import type { EditorContext } from "./extensions";
import "./statusbar.css";

export function countWords(text: string): number {
  let count = 0;
  const withoutCJK = text.replace(
    /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu,
    () => { count++; return " "; },
  );
  for (const _word of withoutCJK.matchAll(/[\p{L}\p{N}][\p{L}\p{N}\p{M}]*(?:['’][\p{L}\p{N}][\p{L}\p{N}\p{M}]*)*/gu)) {
    count++;
  }
  return count;
}

export function statusbarExtension(context: EditorContext): Extension {
  return showPanel.of((view: EditorView): Panel => {
    const dom = document.createElement("div");
    dom.className = "mdw-status";
    dom.setAttribute("role", "status");
    dom.setAttribute("aria-live", "polite");
    const span = (name: string) => {
      const element = document.createElement("span");
      element.className = `mdw-status-${name}`;
      dom.append(element);
      return element;
    };
    const mode = span("mode");
    const message = span("message");
    const file = span("file");
    const words = span("words");
    const position = span("position");
    let cm: ReturnType<typeof getCM> = null;
    let wordTimer: ReturnType<typeof setTimeout> | undefined;
    let countedDocument: Text | undefined;
    let documentWords = 0;
    let hadSelection = false;

    const updateModeAndMessage = () => {
      const state = cm?.state.vim;
      let label = "PLAIN";
      if (state) {
        if (state.visualMode) label = state.visualLine ? "V-LINE" : state.visualBlock ? "V-BLOCK" : "VISUAL";
        else if (state.insertMode) label = cm?.state.overwrite ? "REPLACE" : "INSERT";
        else label = "NORMAL";
      }
      mode.textContent = label;
      mode.dataset.mode = label.toLowerCase();
      const notification = cm?.state.dialog;
      const notice = notification && !notification.querySelector("input") ? notification.textContent : "";
      message.textContent = state?.status || view.state.field(statusMessage) || notice || "";
    };
    const events = ["vim-mode-change", "vim-keypress", "vim-command-done", "dialog"];
    const bindVim = () => {
      const next = getCM(view);
      if (cm === next) return;
      for (const event of events) cm?.off(event, updateModeAndMessage);
      cm = next;
      for (const event of events) cm?.on(event, updateModeAndMessage);
    };
    const updateFileAndPosition = () => {
      const name = context.path.split(/[\\/]/).pop() ?? context.path;
      file.title = context.path;
      file.textContent = `${name}${isDirty(view.state) ? " [+]" : ""}`;
      const head = view.state.selection.main.head;
      const line = view.state.doc.lineAt(head);
      position.textContent = `Ln ${line.number}, Col ${head - line.from + 1}`;
    };
    const updateWords = () => {
      wordTimer = undefined;
      const { state } = view;
      const selected = state.selection.ranges.filter((range) => !range.empty);
      const count = selected.length
        ? selected.reduce((total, range) => total + countWords(state.sliceDoc(range.from, range.to)), 0)
        : countedDocument === state.doc ? documentWords : countWords(state.doc.toString());
      if (!selected.length) {
        countedDocument = state.doc;
        documentWords = count;
      }
      words.textContent = `${count} ${selected.length ? "selected " : ""}words`;
    };
    const scheduleWords = () => {
      clearTimeout(wordTimer);
      const { state } = view;
      const selected = state.selection.ranges.filter((range) => !range.empty);
      const length = selected.length
        ? selected.reduce((total, range) => total + range.to - range.from, 0)
        : state.doc.length;
      if ((!selected.length && countedDocument === state.doc) || length < 50_000) {
        updateWords();
      } else {
        words.textContent = `… ${selected.length ? "selected " : ""}words`;
        wordTimer = setTimeout(updateWords, 200);
      }
      hadSelection = selected.length > 0;
    };

    bindVim();
    updateModeAndMessage();
    updateFileAndPosition();
    scheduleWords();
    return {
      dom,
      update: (update: ViewUpdate) => {
        bindVim();
        updateModeAndMessage();
        updateFileAndPosition();
        if (update.docChanged || (update.selectionSet && (hadSelection || view.state.selection.ranges.some((range) => !range.empty)))) {
          scheduleWords();
        }
      },
      destroy: () => {
        clearTimeout(wordTimer);
        for (const event of events) cm?.off(event, updateModeAndMessage);
      },
    };
  });
}
