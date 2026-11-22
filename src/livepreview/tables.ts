import { markdownLanguage } from "@codemirror/lang-markdown";
import { syntaxTree } from "@codemirror/language";
import type { EditorState, Range } from "@codemirror/state";
import { Decoration, type EditorView, WidgetType } from "@codemirror/view";
import { isActive } from "./active";
import { inDisplayMath } from "./math-ranges";
import { enterSkippedBlocks, statePreview, visibleLines, type SourceRange, type VisibleRange } from "./blocks";

export interface TableCell extends SourceRange { text: string }
export type Alignment = "left" | "center" | "right" | null;
type MarkdownNode = ReturnType<typeof syntaxTree>["topNode"];

interface TableBlock extends SourceRange {
  node: MarkdownNode;
  first: number;
  last: number;
  alignments: Alignment[];
  widths: number[];
}

export function splitTableRow(source: string, offset = 0): TableCell[] {
  const pipes: number[] = [];
  for (let i = 0; i < source.length; i++) {
    if (source[i] === "\\") { i++; continue; }
    if (source[i] === "`") {
      const run = /^`+/.exec(source.slice(i))![0];
      let close = source.indexOf(run, i + run.length);
      while (close >= 0 && (source[close - 1] === "`" || source[close + run.length] === "`")) {
        close = source.indexOf(run, close + run.length);
      }
      if (close >= 0) i = close + run.length - 1;
      else i += run.length - 1;
    } else if (source[i] === "|") pipes.push(i);
  }
  const boundaries = [-1, ...pipes, source.length];
  const cells: TableCell[] = [];
  for (let i = 1; i < boundaries.length; i++) {
    const start = boundaries[i - 1] + 1;
    const end = boundaries[i];
    const raw = source.slice(start, end);
    if ((i === 1 || i === boundaries.length - 1) && !raw.trim() && pipes.length) continue;
    const from = offset + start + raw.length - raw.trimStart().length;
    cells.push({ from, to: from + raw.trim().length, text: raw.trim() });
  }
  return cells;
}

export function columnAlignments(header: string, delimiter: string): Alignment[] | null {
  const width = splitTableRow(header).length;
  const cells = splitTableRow(delimiter);
  if (!width || cells.length !== width || cells.some(cell => !/^:?-+:?$/.test(cell.text))) return null;
  return cells.map(({ text }) => {
    if (text.startsWith(":")) return text.endsWith(":") ? "center" : "left";
    return text.endsWith(":") ? "right" : null;
  });
}

export function tableRow(source: string, offset: number, columns: number): TableCell[] {
  const cells = splitTableRow(source, offset).slice(0, columns);
  const end = offset + source.length;
  while (cells.length < columns) cells.push({ text: "", from: end, to: end });
  return cells;
}

export interface ParsedTable { alignments: Alignment[]; rows: TableCell[][] }

export function parseTable(source: string, offset = 0): ParsedTable | null {
  const lines = source.split("\n");
  if (lines.length < 2) return null;
  const alignments = columnAlignments(lines[0], lines[1]);
  if (!alignments) return null;
  const rows: TableCell[][] = [];
  let start = offset;
  lines.forEach((line, index) => {
    if (index !== 1) rows.push(tableRow(line, start, alignments.length));
    start += line.length + 1;
  });
  return { alignments, rows };
}

export function renderInline(source: string, parent: HTMLElement): void {
  if (!/[\\`*_\[]/.test(source)) {
    parent.append(source);
    return;
  }
  // Force inline context even for cells whose first character is a block marker.
  const text = "x " + source;
  const paragraph = markdownLanguage.parser.parse(text).topNode.firstChild!;
  function children(node: MarkdownNode, target: HTMLElement, from: number, to: number): void {
    let pos = from;
    for (let child = node.firstChild; child; child = child.nextSibling) {
      if (child.from < from || child.to > to) continue;
      target.append(text.slice(pos, child.from));
      render(child, target);
      pos = child.to;
    }
    target.append(text.slice(pos, to));
  }
  function render(node: MarkdownNode, target: HTMLElement): void {
    const first = node.firstChild, last = node.lastChild;
    if (first && last && (node.name === "Emphasis" || node.name === "StrongEmphasis")) {
      const element = document.createElement(node.name === "Emphasis" ? "em" : "strong");
      children(node, element, first.to, last.from);
      target.append(element);
    } else if (first && last && node.name === "InlineCode") {
      const element = document.createElement("code");
      element.textContent = text.slice(first.to, last.from).replace(/\\\|/g, "|");
      target.append(element);
    } else if (node.name === "Link" && node.getChild("URL")) {
      const marks = node.getChildren("LinkMark");
      const url = node.getChild("URL")!;
      const href = text.slice(url.from, url.to).replace(/^<|>$/g, "");
      const link = document.createElement("a");
      if (/^(https?:|mailto:|#|[^:]+$)/i.test(href)) link.setAttribute("href", href);
      children(node, link, marks[0].to, marks[1].from);
      target.append(link);
    } else {
      target.append(text.slice(node.from + Number(node.name === "Escape"), node.to));
    }
  }
  children(paragraph, parent, 2, text.length);
}

export function findTables(state: EditorState, visible: readonly VisibleRange[]): TableBlock[] {
  const tables = new Map<number, TableBlock>();
  for (const range of visible) syntaxTree(state).iterate({
    ...range,
    enter(ref) {
      if (ref.name === "FencedCode" || ref.name === "CodeBlock") return false;
      if (ref.name !== "Table") return;
      if (tables.has(ref.from) || inDisplayMath(state, ref.from)) return false;
      const node = ref.node;
      const header = node.getChild("TableHeader"), delimiter = node.getChild("TableDelimiter");
      if (!header || !delimiter) return false;
      const alignments = columnAlignments(state.sliceDoc(header.from, header.to), state.sliceDoc(delimiter.from, delimiter.to));
      if (alignments) {
        const first = state.doc.lineAt(node.from), last = state.doc.lineAt(node.to);
        const widths = columnWidths(state, node, alignments.length);
        tables.set(ref.from, { node, from: first.from, to: last.to, first: first.number, last: last.number, alignments, widths });
      }
      return false;
    },
  });
  return [...tables.values()];
}

export function columnWidths(state: EditorState, node: MarkdownNode, columns: number): number[] {
  const widths = new Array<number>(columns).fill(3);
  for (let row = node.firstChild; row; row = row.nextSibling) {
    if (row.name !== "TableHeader" && row.name !== "TableRow") continue;
    tableRow(state.sliceDoc(row.from, row.to), row.from, columns)
      .forEach((cell, column) => { widths[column] = Math.max(widths[column], cell.text.length); });
  }
  return widths;
}

// Bounded widgets give CodeMirror source positions between sections of tall tables.
const chunkLines = 16;

class TableWidget extends WidgetType {
  constructor(
    readonly from: number, readonly source: string, readonly rows: TableCell[][],
    readonly alignments: Alignment[], readonly widths: number[], readonly first: boolean, readonly last: boolean,
  ) { super(); }

  eq(other: TableWidget): boolean {
    return this.from === other.from && this.source === other.source && this.first === other.first &&
      this.last === other.last && this.alignments.join() === other.alignments.join() && this.widths.join() === other.widths.join();
  }

  toDOM(view: EditorView): HTMLElement {
    const wrapper = document.createElement("div");
    wrapper.className = "cm-md-table";
    if (this.first) wrapper.classList.add("cm-md-table-first");
    if (this.last) wrapper.classList.add("cm-md-table-last");
    const table = document.createElement("table");
    if (!(this.first && this.last)) {
      // Chunks of one table must share column widths, so size them from the whole table's longest cells.
      const total = this.widths.reduce((sum, width) => sum + width, 0);
      table.style.width = `min(100%, calc(${total}ch + ${this.widths.length * 1.5}em))`;
      const columns = document.createElement("colgroup");
      for (const width of this.widths) {
        const column = document.createElement("col");
        column.style.width = `${(width / total) * 100}%`;
        columns.append(column);
      }
      table.append(columns);
    }
    const body = table.createTBody();
    this.rows.forEach((row, index) => {
      const header = this.first && index === 0;
      const tr = (header ? table.createTHead() : body).insertRow();
      row.forEach((cell, column) => {
        const td = document.createElement(header ? "th" : "td");
        const alignment = this.alignments[column];
        if (alignment) td.style.textAlign = alignment;
        renderInline(cell.text, td);
        td.addEventListener("mousedown", event => event.preventDefault());
        td.addEventListener("click", event => {
          event.preventDefault();
          view.dispatch({ selection: { anchor: cell.from }, scrollIntoView: true });
          view.focus();
        });
        tr.append(td);
      });
    });
    wrapper.append(table);
    return wrapper;
  }
}

function renderChunk(state: EditorState, table: TableBlock, first: number): Range<Decoration> {
  const last = Math.min(table.last, first + chunkLines - 1);
  const from = state.doc.line(first).from, to = state.doc.line(last).to;
  const rows: TableCell[][] = [];
  let row = table.node.childAfter(from);
  while (row && row.from <= to) {
    if (row.name === "TableHeader" || row.name === "TableRow") {
      rows.push(tableRow(state.sliceDoc(row.from, row.to), row.from, table.alignments.length));
    }
    row = row.nextSibling;
  }
  const widget = new TableWidget(from, state.sliceDoc(from, to), rows, table.alignments, table.widths,
    first === table.first, last === table.last);
  return Decoration.replace({ block: true, widget }).range(from, to);
}

const preview = statePreview({
  find: findTables,
  decorate(state, tables, visible) {
    const ranges: Range<Decoration>[] = [];
    const lines = visibleLines(state, visible);
    for (const table of tables) {
      const active = isActive(state, table.from, table.to);
      let previous = -1;
      for (const line of lines) {
        if (line < table.first || line > table.last) continue;
        if (active) {
          ranges.push(Decoration.line({ class: "cm-md-table-source" }).range(state.doc.line(line).from));
        } else {
          const first = line - (line - table.first) % chunkLines;
          if (first !== previous) ranges.push(renderChunk(state, table, first));
          previous = first;
        }
      }
    }
    return Decoration.set(ranges, true);
  },
});

export function activeTables(state: EditorState): SourceRange[] {
  return state.field(preview.field, false)?.items.filter(table => isActive(state, table.from, table.to)) ?? [];
}

export const tablePreview = [preview.extension, enterSkippedBlocks(preview.field)];
