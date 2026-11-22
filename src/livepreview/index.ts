import type { Extension } from "@codemirror/state";
import { previewPlugin } from "./hide";
import { codeBlockPreview } from "./codeblock";
import { tablePreview } from "./tables";
import { mathPreview } from "./math";
import { imagePreview } from "./images";
import type { EditorContext } from "../extensions";
import "./blocks.css";

export function livePreview(context?: Pick<EditorContext, "dir" | "path">): Extension {
  return [previewPlugin, codeBlockPreview, tablePreview, mathPreview, context ? imagePreview(context) : []];
}
