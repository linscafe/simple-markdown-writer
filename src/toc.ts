import { syntaxTree } from "@codemirror/language";
import { type EditorState, type Extension, Facet } from "@codemirror/state";
import { EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import "./toc.css";

export interface Heading {
  level: number;
  text: string;
  from: number;
}

function plainText(source: string): string {
  return source
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_`~]+/g, "")
    .trim();
}

// Uses only the tree parsed so far: forcing a full parse here resets CodeMirror's
// background parse, which updates the view, which re-renders the list, without end.
export function documentHeadings(state: EditorState): Heading[] {
  const tree = syntaxTree(state);
  const headings: Heading[] = [];
  tree.iterate({
    enter(node) {
      const match = /^(ATX|Setext)Heading(\d)$/.exec(node.name);
      if (!match) return;
      const line = state.doc.lineAt(node.from);
      const raw = match[1] === "ATX"
        ? state.sliceDoc(node.from, node.to).replace(/^\s*#{1,6}/, "").replace(/\s#+\s*$/, "")
        : state.sliceDoc(node.from, line.to);
      headings.push({ level: Number(match[2]), text: plainText(raw.replace(/^\s*>\s*/, "")) || "(untitled)", from: node.from });
      return false;
    },
  });
  return headings;
}

export function currentHeading(headings: Heading[], position: number): number {
  let current = -1;
  for (const [index, heading] of headings.entries()) {
    if (heading.from > position) break;
    current = index;
  }
  return current;
}

const initiallyVisible = Facet.define<boolean, boolean>({ combine: (values) => values.some(Boolean) });
// Keyed by view.dom so the choice survives view.setState when another document opens in the window.
const visibility = new WeakMap<HTMLElement, boolean>();
const isVisible = (view: EditorView) => visibility.get(view.dom) ?? view.state.facet(initiallyVisible);
// CodeMirror owns the editor's class attribute, so the layout class goes through editorAttributes.
const openClass = EditorView.editorAttributes.of((view) => isVisible(view) ? { class: "mdw-toc-open" } : null);

function sameHeadings(a: Heading[], b: Heading[]): boolean {
  return a.length === b.length && a.every((h, i) => h.from === b[i].from && h.level === b[i].level && h.text === b[i].text);
}

class TocPanel {
  readonly dom = document.createElement("nav");
  private headings: Heading[] = [];
  private visible: boolean;

  constructor(private readonly view: EditorView) {
    this.dom.className = "mdw-toc";
    this.dom.setAttribute("aria-label", "Table of contents");
    this.dom.addEventListener("mousedown", (event) => event.preventDefault());
    this.dom.addEventListener("click", (event) => this.jump(event));
    view.dom.append(this.dom);
    this.visible = isVisible(view);
    this.setVisible(this.visible);
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    visibility.set(this.view.dom, visible);
    this.dom.hidden = !visible;
    if (visible) this.render(true);
  }

  update(update: ViewUpdate): void {
    if (!this.visible) return;
    if (update.docChanged || syntaxTree(update.startState) !== syntaxTree(update.state)) this.render();
    if (update.selectionSet) this.highlight();
  }

  private render(force = false): void {
    const headings = documentHeadings(this.view.state);
    if (!force && sameHeadings(headings, this.headings)) return;
    this.headings = headings;
    const list = document.createElement("ol");
    for (const [index, heading] of this.headings.entries()) {
      const item = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.index = String(index);
      button.dataset.level = String(heading.level);
      button.textContent = heading.text;
      button.title = heading.text;
      item.append(button);
      list.append(item);
    }
    const empty = document.createElement("p");
    empty.className = "mdw-toc-empty";
    empty.textContent = "No headings";
    this.dom.replaceChildren(this.headings.length ? list : empty);
    this.highlight();
  }

  private highlight(): void {
    const current = currentHeading(this.headings, this.view.state.selection.main.head);
    for (const button of this.dom.querySelectorAll<HTMLButtonElement>("button")) {
      if (Number(button.dataset.index) === current) button.setAttribute("aria-current", "location");
      else button.removeAttribute("aria-current");
    }
  }

  private jump(event: MouseEvent): void {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>("button[data-index]");
    const heading = button && this.headings[Number(button.dataset.index)];
    if (!heading) return;
    this.view.dispatch({
      selection: { anchor: heading.from },
      effects: EditorView.scrollIntoView(heading.from, { y: "start", yMargin: 24 }),
    });
    this.view.focus();
  }

  destroy(): void {
    this.dom.remove();
  }
}

const tocPlugin = ViewPlugin.fromClass(TocPanel);

export function setTocVisible(view: EditorView, visible: boolean): void {
  visibility.set(view.dom, visible);
  view.plugin(tocPlugin)?.setVisible(visible);
  // Recompute editor attributes (the layout class) and re-measure the narrower text area.
  view.dispatch({});
}

export function tocExtension(context: { showToc?: boolean }): Extension {
  return [initiallyVisible.of(context.showToc ?? false), tocPlugin, openClass];
}
