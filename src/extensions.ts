import type { Extension } from "@codemirror/state";
import { drawSelection, keymap } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { savedDocument, statusMessage } from "./document";
import { vimExtension } from "./vim";
import { statusbarExtension } from "./statusbar";
import { reloadExtension } from "./reload";
import { themeExtension } from "./theme";
import type { UserConfig } from "./settings";
import { livePreview } from "./livepreview";
import { imageInsertionExtension } from "./insert/images";
import { linkPasteExtension } from "./insert/links";
import { navigationExtension } from "./navigate";
import { pathCompletionExtension } from "./complete";
import { housekeepingExtension } from "./housekeeping";

export interface EditorContext {
  path: string;
  dir: string;
  config?: UserConfig;
  save(): Promise<void>;
  openDocument?(path: string, cursor?: number): Promise<boolean>;
  adoptDocument?(path: string): Promise<void>;
  quit(): void;
}

export function buildExtensions(context: EditorContext): Extension[] {
  return [
    vimExtension(context),
    markdown({ base: markdownLanguage, codeLanguages: languages }),
    livePreview(context),
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
  ];
}
