import { syntaxTree } from "@codemirror/language";
import { StateField, type EditorState, type Text } from "@codemirror/state";
import { insideLiteral, touchesVisible, visibleLines, type SourceRange, type VisibleRange } from "./blocks";

export interface MathRange extends SourceRange { expression: string; block: boolean }

function escaped(source: string, at: number): boolean {
  let slashes = 0;
  while (at > 0 && source[--at] === "\\") slashes++;
  return slashes % 2 === 1;
}

// CodeMirror shares unchanged text leaves across edits. Their relative delimiter offsets stay valid.
const leafDelimiters = new WeakMap<Text, number[]>();

function delimiters(leaf: Text): number[] {
  const cached = leafDelimiters.get(leaf);
  if (cached) return cached;
  const found: number[] = [];
  let from = 0;
  for (const text of leaf.iterLines()) {
    const match = /^\s*\$\$/.exec(text);
    if (match) found.push(from + match[0].length - 2);
    from += text.length + 1;
  }
  leafDelimiters.set(leaf, found);
  return found;
}

function* leavesFrom(doc: Text, from: number, offset = 0): Generator<{ leaf: Text; offset: number }> {
  if (!doc.children) {
    yield { leaf: doc, offset };
    return;
  }
  for (const child of doc.children) {
    if (offset + child.length >= from) yield* leavesFrom(child, from, offset);
    offset += child.length + 1;
  }
}

interface DisplayMath extends SourceRange { leading: number; trailing: number }

interface Pairing {
  blocks: DisplayMath[];
  next: number;
}

interface MathIndex {
  tree: ReturnType<typeof syntaxTree>;
  // Filled lazily up to the furthest position queried, so edits only re-pair
  // delimiters between the edit and the viewport.
  pairing: Pairing;
}

function pairUntil(state: EditorState, index: MathIndex, upto: number): DisplayMath[] {
  const pairing = index.pairing;
  if (pairing.next > upto) return pairing.blocks;
  let opening: { from: number; leading: number } | undefined;
  for (const { leaf, offset } of leavesFrom(state.doc, pairing.next)) {
    if (offset > upto && !opening) break;
    for (const relative of delimiters(leaf)) {
      const start = offset + relative;
      if (start < pairing.next) continue;
      if (start > upto && !opening) {
        pairing.next = start;
        return pairing.blocks;
      }
      if (insideLiteral(state, start, true)) continue;
      const line = state.doc.lineAt(start);
      const rest = line.text.slice(start + 2 - line.from);
      if (opening) {
        if (!rest.trim()) {
          pairing.blocks.push({ from: opening.from, to: line.to, leading: opening.leading, trailing: line.to - start });
          opening = undefined;
        }
      } else {
        const leading = start + 2 - line.from;
        const close = rest.search(/\$\$\s*$/);
        if (close >= 0 && !escaped(rest, close)) {
          pairing.blocks.push({ from: line.from, to: line.to, leading, trailing: rest.length - close });
        } else {
          opening = { from: line.from, leading };
        }
      }
    }
    pairing.next = offset + leaf.length + 1;
  }
  return pairing.blocks;
}

function firstEndingAtOrAfter(blocks: readonly DisplayMath[], pos: number): number {
  let low = 0, high = blocks.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (blocks[middle].to < pos) low = middle + 1;
    else high = middle;
  }
  return low;
}

export const mathBlockIndex = StateField.define<MathIndex>({
  create(state) {
    return {
      tree: syntaxTree(state),
      pairing: { blocks: [], next: 0 },
    };
  },
  update(value, transaction) {
    const state = transaction.state;
    const tree = syntaxTree(state);
    if (!transaction.docChanged && tree === value.tree) return value;
    const changes = transaction.changes;
    // Literal status cannot change before the first edit or before the end of the
    // previously parsed tree, except on the line above, which may become a table header.
    let start = tree === value.tree ? state.doc.length
      : Math.min(changes.mapPos(value.tree.length, -1), tree.length);
    changes.iterChangedRanges((_oldFrom, _oldTo, from) => {
      start = Math.min(start, from);
    });
    const line = state.doc.lineAt(start);
    start = line.number > 1 ? state.doc.line(line.number - 1).from : 0;
    const old = value.pairing;
    if (old.next <= start) return { tree, pairing: { ...old, blocks: old.blocks.slice() } };
    const kept = old.blocks.slice(0, firstEndingAtOrAfter(old.blocks, start));
    return { tree, pairing: { blocks: kept, next: kept.length ? kept[kept.length - 1].to + 1 : 0 } };
  },
});

export function inDisplayMath(state: EditorState, pos: number): boolean {
  const index = state.field(mathBlockIndex, false);
  if (!index) return false;
  const blocks = pairUntil(state, index, pos);
  const block = blocks[firstEndingAtOrAfter(blocks, pos)];
  return !!block && block.from <= pos;
}

export function findMathRanges(state: EditorState, visible: readonly VisibleRange[]): MathRange[] {
  const index = state.field(mathBlockIndex);
  const blocks = pairUntil(state, index, Math.max(0, ...visible.map((range) => range.to)));
  const result = new Map<number, MathRange>();
  for (const range of visible) {
    for (let i = firstEndingAtOrAfter(blocks, range.from); i < blocks.length && blocks[i].from <= range.to; i++) {
      const { from, to, leading, trailing } = blocks[i];
      if (!result.has(from)) result.set(from, { from, to, block: true,
        expression: state.sliceDoc(from + leading, to - trailing).trim() });
    }
  }
  for (const number of visibleLines(state, visible)) {
    const line = state.doc.line(number);
    if (inDisplayMath(state, line.from)) continue;
    for (let i = 0; i < line.text.length; i++) {
      if (line.text[i] !== "$" || escaped(line.text, i) || /[\s$]/.test(line.text[i + 1] ?? " ") ||
        (/[,.;:!?]/.test(line.text[i + 1]) && /\s/.test(line.text[i + 2] ?? " ")) ||
        /[\p{L}\p{N}$]/u.test(line.text[i - 1] ?? "") || insideLiteral(state, line.from + i, true)) continue;
      for (let end = i + 2; end < line.text.length; end++) {
        if (line.text[end] !== "$" || escaped(line.text, end)) continue;
        if (/[\s$]/.test(line.text[end - 1]) || /[\d$]/.test(line.text[end + 1] ?? "") ||
          insideLiteral(state, line.from + end, true)) break;
        const from = line.from + i, to = line.from + end + 1;
        if (touchesVisible(from, to, visible)) {
          result.set(from, { from, to, expression: line.text.slice(i + 1, end), block: false });
        }
        i = end;
        break;
      }
    }
  }
  return [...result.values()].sort((a, b) => a.from - b.from);
}
