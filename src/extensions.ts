import type { Extension } from "@codemirror/state";
import { drawSelection, keymap } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { savedDocument, statusMessage } from "./document";
import { vimExtension } from "./vim";
import { statusbarExtension } from "./statusbar";
import { reloadExtension } from "./reload";
import { themeExtension } from "./theme";
import type { UserConfig } from "./settings";
import { imageInsertionExtension } from "./insert/images";
import { linkPasteExtension } from "./insert/links";
import { navigationExtension } from "./navigate";
import { pathCompletionExtension } from "./complete";
import { housekeepingExtension } from "./housekeeping";
import { tocExtension } from "./toc";
import { modeExtension } from "./mode";
import { zoomExtension } from "./zoom";

export interface EditorContext {
  path: string;
  dir: string;
  config?: UserConfig;
  showToc?: boolean;
  /** Show Markdown as plain source instead of the live preview. */
  sourceView?: boolean;
  save(): Promise<void>;
  openDocument?(path: string, cursor?: number): Promise<boolean>;
  adoptDocument?(path: string): Promise<void>;
  quit(): void;
}

export function buildExtensions(context: EditorContext): Extension[] {
  return [
    vimExtension(context),
    modeExtension(context),
    imageInsertionExtension(context),
    linkPasteExtension(),
    navigationExtension(context),
    pathCompletionExtension(context),
    housekeepingExtension(context),
    history(),
    drawSelection(),
    keymap.of([...defaultKeymap, ...historyKeymap]),
    savedDocument,
    statusMessage,
    statusbarExtension(context),
    reloadExtension(context),
    themeExtension(),
    tocExtension(context),
    zoomExtension(context),
  ];
}
