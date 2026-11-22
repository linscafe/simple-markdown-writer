import type { EditorState, Extension, Range } from "@codemirror/state";
import { Decoration, WidgetType, type EditorView } from "@codemirror/view";
import { convertFileSrc } from "@tauri-apps/api/core";
import { join } from "@tauri-apps/api/path";
import type { EditorContext } from "../extensions";
import { isActive } from "./active";
import { mathAt } from "./math";
import { insideLiteral, statePreview, touchesVisible, visibleLines, type SourceRange, type VisibleRange } from "./blocks";

export interface ImageSyntax extends SourceRange {
  src: string;
  alt: string;
  width?: number;
  height?: number;
  wiki: boolean;
}

function sizedLabel(label: string): { label: string; width?: number; height?: number } {
  const size = /\|([1-9]\d*)(?:x([1-9]\d*))?$/.exec(label);
  return size ? { label: label.slice(0, size.index), width: Number(size[1]), height: size[2] ? Number(size[2]) : undefined }
    : { label };
}

function closing(source: string, start: number, open: string, close: string): number {
  let depth = 1;
  let angle = false;
  for (let i = start; i < source.length; i++) {
    if (source[i] === "\\") { i++; continue; }
    if (open === "(" && source[i] === "<") angle = true;
    else if (open === "(" && source[i] === ">") angle = false;
    if (angle) continue;
    if (source[i] === open) depth++;
    if (source[i] === close && --depth === 0) return i;
  }
  return -1;
}

export function parseImages(source: string, offset = 0): ImageSyntax[] {
  const images: ImageSyntax[] = [];
  for (let i = 0; i < source.length; i++) {
    if (source[i] === "\\") { i++; continue; }
    if (!source.startsWith("![", i)) continue;
    let to: number;
    let src: string;
    let alt: string;
    let size: ReturnType<typeof sizedLabel>;
    const wiki = source.startsWith("![[", i);
    if (wiki) {
      const end = source.indexOf("]]", i + 3);
      if (end < 0) continue;
      size = sizedLabel(source.slice(i + 3, end).trim());
      src = size.label.trim();
      alt = src;
      to = end + 2;
    } else {
      const bracket = closing(source, i + 2, "[", "]");
      if (bracket < 0 || source[bracket + 1] !== "(") continue;
      const end = closing(source, bracket + 2, "(", ")");
      if (end < 0) continue;
      size = sizedLabel(source.slice(i + 2, bracket));
      alt = size.label.replace(/\\([\[\]\\])/g, "$1");
      const destination = source.slice(bracket + 2, end).trim();
      const match = /^(?:<([^>]+)>|((?:\\.|[^\s])+?))(?=\s+["']|$)/.exec(destination);
      if (!match) continue;
      src = (match[1] ?? match[2]).replace(/\\([()\\ ])/g, "$1");
      to = end + 1;
    }
    if (!src) continue;
    const attribute = /^\s*\{width=([1-9]\d*)\}/.exec(source.slice(to));
    if (attribute) to += attribute[0].length;
    images.push({ from: offset + i, to: offset + to, src, alt, wiki,
      width: attribute ? Number(attribute[1]) : size.width, height: size.height });
    i = to - 1;
  }
  return images;
}

export async function resolveImageSources(image: ImageSyntax, ctx: Pick<EditorContext, "dir" | "path">): Promise<string[]> {
  if (/^https?:\/\//i.test(image.src)) return [image.src];
  if (/^[a-z][a-z\d+.-]*:/i.test(image.src)) return [];
  let src: string;
  try { src = decodeURIComponent(image.src); }
  catch { src = image.src; }
  const paths = [await join(ctx.dir, src)];
  if (image.wiki) {
    const name = ctx.path.replace(/\\/g, "/").split("/").pop()!.replace(/\.[^.]+$/, "");
    paths.push(await join(ctx.dir, `${name}.assets`, src));
  }
  return paths.map((path) => convertFileSrc(path));
}

export class ImageWidget extends WidgetType {
  private retired = new WeakSet<HTMLElement>();
  constructor(readonly image: ImageSyntax, readonly ctx: Pick<EditorContext, "dir" | "path">,
    readonly thumbnail: boolean, readonly standalone: boolean) { super(); }

  eq(other: ImageWidget): boolean {
    return this.image.src === other.image.src && this.image.alt === other.image.alt &&
      this.image.width === other.image.width && this.image.height === other.image.height &&
      this.image.wiki === other.image.wiki && this.ctx.dir === other.ctx.dir && this.ctx.path === other.ctx.path &&
      this.thumbnail === other.thumbnail && this.standalone === other.standalone;
  }

  get estimatedHeight(): number { return this.thumbnail ? 64 : this.image.height ?? 80; }

  toDOM(view: EditorView): HTMLElement {
    const wrapper = document.createElement("span");
    wrapper.className = `cm-md-image${this.thumbnail ? " cm-md-image-thumbnail" : this.standalone ? " cm-md-image-standalone" : ""}`;
    const image = document.createElement("img");
    image.alt = this.image.alt;
    if (this.image.width) image.width = this.image.width;
    if (this.image.height) image.height = this.image.height;
    wrapper.append(image);
    const failed = (): void => {
      if (this.retired.has(wrapper)) return;
      wrapper.classList.add("cm-md-image-error");
      wrapper.textContent = this.image.src;
      view.requestMeasure();
    };
    image.addEventListener("load", () => {
      if (!this.retired.has(wrapper)) view.requestMeasure();
    });
    void resolveImageSources(this.image, this.ctx).then((sources) => {
      if (this.retired.has(wrapper)) return;
      let next = 0;
      image.addEventListener("error", () => {
        if (this.retired.has(wrapper)) return;
        if (next < sources.length) image.src = sources[next++];
        else failed();
      });
      if (sources.length) image.src = sources[next++];
      else failed();
    }).catch(failed);
    if (!this.thumbnail) {
      wrapper.addEventListener("mousedown", (event) => event.preventDefault());
      wrapper.addEventListener("click", () => {
        view.dispatch({ selection: { anchor: view.posAtDOM(wrapper) }, scrollIntoView: true });
        view.focus();
      });
    }
    return wrapper;
  }

  destroy(dom: HTMLElement): void { this.retired.add(dom); }
}

export function findImages(state: EditorState, visible: readonly VisibleRange[]): ImageSyntax[] {
  return visibleLines(state, visible).flatMap((number) => {
    const line = state.doc.line(number);
    return parseImages(line.text, line.from).filter((image) =>
      touchesVisible(image.from, image.to, visible) && !insideLiteral(state, image.from) && !mathAt(state, image.from));
  });
}

export function imagePreview(ctx: Pick<EditorContext, "dir" | "path">): Extension {
  return statePreview({
    find: findImages,
    decorate(state, images) {
      const ranges: Range<Decoration>[] = [];
      for (const image of images) {
        const line = state.doc.lineAt(image.from);
        const active = isActive(state, image.from, image.to);
        const standalone = !state.sliceDoc(line.from, image.from).trim() && !state.sliceDoc(image.to, line.to).trim();
        const widget = new ImageWidget(image, ctx, active, standalone);
        ranges.push(active ? Decoration.widget({ widget, block: true, side: 1 }).range(line.to)
          : Decoration.replace({ widget }).range(image.from, image.to));
      }
      return Decoration.set(ranges, true);
    },
  }).extension;
}
