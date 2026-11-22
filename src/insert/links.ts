import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

export function pastedLink(text: string, selection: string): string | null {
  if (text !== text.trim() || /\s/.test(text)) return null;
  let url: URL;
  try { url = new URL(text); } catch { return null; }
  if (!["http:", "https:", "mailto:"].includes(url.protocol)) return null;
  if (selection) return `[${selection}](${text.replace(/\(/g, "%28").replace(/\)/g, "%29")})`;
  if (url.protocol !== "mailto:" && /\.(?:png|jpe?g|gif|webp|svg)$/i.test(url.pathname)) {
    return `![](${text.replace(/\(/g, "%28").replace(/\)/g, "%29")})`;
  }
  return `<${text}>`;
}

export function linkPasteExtension(): Extension {
  return EditorView.domEventHandlers({
    paste(event, view) {
      if (view.state.readOnly || !event.clipboardData) return false;
      if (Array.from(event.clipboardData.items).some((item) => /^image\/(png|jpeg|gif|webp)$/.test(item.type))) return false;
      const range = view.state.selection.main;
      const insert = pastedLink(event.clipboardData.getData("text/plain"), view.state.sliceDoc(range.from, range.to));
      if (insert === null) return false;
      event.preventDefault();
      view.dispatch(view.state.replaceSelection(insert), { userEvent: "input.paste", scrollIntoView: true });
      return true;
    },
  });
}
