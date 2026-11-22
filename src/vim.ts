import { Compartment, Prec, type Extension } from "@codemirror/state";
import { EditorView, ViewPlugin, keymap, lineNumbers } from "@codemirror/view";
import { invoke } from "@tauri-apps/api/core";
import { Vim, vim, type ActionFn } from "@replit/codemirror-vim";
import type { EditorContext } from "./extensions";
import { isDirty, markSaved, showMessage } from "./document";
import { readText, writeText } from "./clipboard";

interface VimContext {
  context: EditorContext;
  keys: Compartment;
  wrapping: Compartment;
  numbers: Compartment;
  enabled: boolean;
}

const contexts = new WeakMap<EditorView, VimContext>();
let activeView: EditorView | undefined;

type ExHandler = Parameters<typeof Vim.defineEx>[2];

export function registerEx(name: string, short: string, fn: ExHandler): void {
  Vim.defineEx(name, short, fn);
}

export interface VimMapping {
  lhs: string;
  rhs: string;
  mode: string;
}

export function applyVimMappings(maps: VimMapping[]): void {
  const modes: Record<string, string> = {
    n: "normal", i: "insert", v: "visual", o: "operatorPending",
  };
  for (const { lhs, rhs, mode } of maps) {
    Vim.map(lhs, rhs, modes[mode] ?? mode);
  }
}

function message(view: EditorView | undefined, text: string): void {
  if (view && contexts.has(view)) view.dispatch({ effects: showMessage.of(text) });
}

function save(view: EditorView, quitAfter: boolean): void {
  const entry = contexts.get(view);
  if (!entry) return;
  void entry.context.save().then(() => {
    if (quitAfter && contexts.has(view)) quit(view, false);
  }).catch(() => {
    // The save handler reports failures and leaves the document dirty.
  });
}

function quit(view: EditorView, force: boolean): void {
  if (!force && isDirty(view.state)) {
    message(view, "Unsaved changes. Use :w to save or :q! to discard.");
    return;
  }
  contexts.get(view)?.context.quit();
}

async function reload(view: EditorView, force: boolean): Promise<void> {
  const entry = contexts.get(view);
  if (!entry) return;
  if (!force && isDirty(view.state)) {
    message(view, "Unsaved changes. Use :e! to discard and reload.");
    return;
  }
  const original = view.state.doc;
  try {
    const content = await invoke<string>("read_file", { path: entry.context.path });
    if (!contexts.has(view)) return;
    if (view.state.doc !== original) {
      message(view, "Reload cancelled: document changed while reading.");
      return;
    }
    const changes = view.state.changes({ from: 0, to: original.length, insert: content });
    view.dispatch({
      changes,
      selection: { anchor: Math.min(view.state.selection.main.head, content.length) },
      effects: [markSaved.of(changes.apply(original)), showMessage.of("Reloaded")],
    });
  } catch (error) {
    message(view, `Reload failed: ${String(error)}`);
  }
}

function toggleVim(view: EditorView): boolean {
  const entry = contexts.get(view);
  if (!entry) return false;
  entry.enabled = !entry.enabled;
  view.dispatch({ effects: entry.keys.reconfigure(entry.enabled ? vim() : []) });
  return true;
}

registerEx("write", "w", (cm) => save(cm.cm6 as EditorView, false));
registerEx("quit", "q", (cm, params) => quit(cm.cm6 as EditorView, params.argString?.trim() === "!"));
registerEx("wq", "wq", (cm) => save(cm.cm6 as EditorView, true));
registerEx("xit", "x", (cm) => {
  const view = cm.cm6 as EditorView;
  if (isDirty(view.state)) save(view, true);
  else quit(view, false);
});
registerEx("edit", "e", (cm, params) => {
  void reload(cm.cm6 as EditorView, params.argString?.trim() === "!");
});
registerEx("novim", "novim", (cm) => { toggleVim(cm.cm6 as EditorView); });

Vim.defineOption("wrap", true, "boolean", [], (value, cm) => {
  const view = cm?.cm6 as EditorView | undefined;
  const entry = view && contexts.get(view);
  if (!entry || !view) return true;
  if (value !== undefined) {
    view.dispatch({ effects: entry.wrapping.reconfigure(value ? EditorView.lineWrapping : []) });
  }
  return entry.wrapping.get(view.state) === EditorView.lineWrapping;
});
Vim.defineOption("number", false, "boolean", ["nu"], (value, cm) => {
  const view = cm?.cm6 as EditorView | undefined;
  const entry = view && contexts.get(view);
  if (!entry || !view) return false;
  if (value !== undefined) {
    view.dispatch({ effects: entry.numbers.reconfigure(value ? [lineNumbers()] : []) });
  }
  return (entry.numbers.get(view.state) as Extension[]).length > 0;
});

Vim.noremap("j", "gj", "normal");
Vim.noremap("k", "gk", "normal");
Vim.noremap("j", "gj", "visual");
Vim.noremap("k", "gk", "visual");

type RegisterController = ReturnType<typeof Vim.getRegisterController>;
const clipboardControllers = new WeakSet<RegisterController>();

function connectClipboard(): void {
  const controller = Vim.getRegisterController();
  if (clipboardControllers.has(controller)) return;
  clipboardControllers.add(controller);
  const pushText = controller.pushText.bind(controller);
  controller.pushText = (name, operator, text, linewise, blockwise) => {
    // Bypass the engine's unguarded Clipboard API call for the explicit + register.
    pushText(name === "+" ? '"' : name, operator, text, linewise, blockwise);
    if (name === "_") return;
    const value = controller.unnamedRegister.toString();
    controller.getRegister("+").setText(value, controller.unnamedRegister.linewise,
      controller.unnamedRegister.blockwise);
    const view = activeView;
    void writeText(value).catch((error: unknown) => {
      message(view, `Clipboard write failed: ${String(error)}`);
    });
  };
}

// Vim binds action callbacks to its action table, allowing delegation to its built-in paste.
interface PasteActions {
  paste: ActionFn;
}

Vim.defineAction("mdwPaste", function (this: PasteActions, cm, args, state) {
  const name = args.registerName;
  if (name && name !== "+" && name !== '"') {
    this.paste(cm, args, state);
    return;
  }
  const view = cm.cm6 as EditorView;
  const controller = Vim.getRegisterController();
  const register = controller.getRegister("+");
  const original = view.state.doc;
  const selection = view.state.selection;
  const paste = (text: string, errorMessage?: string) => {
    if (!contexts.has(view) || cm.state.vim !== state) return;
    if (view.state.doc !== original || !view.state.selection.eq(selection)) {
      message(view, "Paste cancelled: document or selection changed while reading clipboard.");
      return;
    }
    if (text) {
      // External clipboard text has no Vim metadata; preserve it only for our own text.
      if (text !== register.toString()) register.setText(text, text.endsWith("\n"));
      controller.unnamedRegister.setText(text, register.linewise, register.blockwise);
    }
    this.paste(cm, { ...args, registerName: '"' }, state);
    if (errorMessage) {
      const emptyRegister = !text && !controller.unnamedRegister.toString();
      message(view, emptyRegister ? `${errorMessage} The internal unnamed register is also empty.` : errorMessage);
    }
  };
  void readText().then(
    (text) => paste(text, text ? undefined : "Clipboard is empty or unavailable. Using internal unnamed register."),
    (error: unknown) => paste("", `Clipboard read failed: ${String(error)}. Using internal unnamed register.`),
  );
});
for (const [keys, after, matchIndent] of [
  ["p", true, false], ["P", false, false], ["]p", true, true], ["[p", false, true],
] as const) {
  Vim.mapCommand(keys, "action", "mdwPaste", { after, matchIndent }, { isEdit: true });
}

export function vimExtension(context: EditorContext): Extension {
  const enabled = context.config?.vim !== false;
  if (enabled) applyVimMappings(context.config?.vim_maps ?? []);
  const entry: VimContext = {
    context, keys: new Compartment(), wrapping: new Compartment(),
    numbers: new Compartment(), enabled,
  };
  return [
    entry.keys.of(enabled ? vim() : []),
    entry.wrapping.of(EditorView.lineWrapping),
    entry.numbers.of([]),
    ViewPlugin.define((view) => {
      contexts.set(view, entry);
      connectClipboard();
      const activate = () => { activeView = view; };
      view.dom.addEventListener("focusin", activate);
      return {
        destroy: () => {
          contexts.delete(view);
          view.dom.removeEventListener("focusin", activate);
          if (activeView === view) activeView = undefined;
        },
      };
    }),
    Prec.highest(keymap.of([
      { key: "Mod-s", run: (view) => { save(view, false); return true; }, preventDefault: true },
      { key: "Ctrl-Alt-v", run: toggleVim, preventDefault: true },
    ])),
  ];
}
