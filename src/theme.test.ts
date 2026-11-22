import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { getCM, Vim } from "@replit/codemirror-vim";
import { themeExtension } from "./theme";
import { vimExtension } from "./vim";
import { statusMessage } from "./document";

import * as theme from "./theme";

let dark = false;
const mediaChanges = new Set<() => void>();

beforeEach(() => {
  vi.stubGlobal("matchMedia", vi.fn(() => ({
    get matches() { return dark; },
    addEventListener: (_event: string, listener: () => void) => { mediaChanges.add(listener); },
    addListener: () => {},
    removeListener: () => {},
    removeEventListener: () => {},
  })));
  dark = false;
  theme.setTheme("light");
});

afterEach(() => {
  document.querySelector<HTMLInputElement>(".mdw-theme-picker input")?.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
  );
  theme.installUserThemes([]);
  theme.setTheme("light");
  vi.unstubAllGlobals();
});

function key(key: string, ctrlKey = false): void {
  document.querySelector(".mdw-theme-picker input")?.dispatchEvent(
    new KeyboardEvent("keydown", { key, ctrlKey, bubbles: true, cancelable: true }),
  );
}

describe("themes", () => {
  it("lists every built-in and sets the root theme attribute", () => {
    expect(theme.listThemes()).toEqual([
      "auto", "light", "dark", "solarized-light", "solarized-dark", "nord", "gruvbox-dark", "dracula", "sepia",
      "tokyonight-night", "tokyonight-storm", "tokyonight-day",
      "catppuccin-mocha", "catppuccin-macchiato", "catppuccin-frappe", "catppuccin-latte", "gruvbox-light",
      "kanagawa-wave", "kanagawa-dragon", "kanagawa-lotus", "rose-pine", "rose-pine-moon", "rose-pine-dawn",
      "nightfox", "dayfox", "carbonfox", "onedark", "onelight", "everforest-dark", "everforest-light", "sonokai",
      "github-dark", "github-light", "material-oceanic", "material-palenight", "monokai",
      "ayu-dark", "ayu-mirage", "ayu-light", "oxocarbon", "nightfly", "moonfly",
      "papercolor-light", "papercolor-dark",
    ]);
    theme.setTheme("nord");
    expect(document.documentElement.dataset.theme).toBe("nord");
    expect(() => theme.setTheme("missing")).toThrow("Unknown theme");
    expect(document.documentElement.dataset.theme).toBe("nord");
  });

  it("follows media query changes live only in auto mode", () => {
    theme.setTheme("auto");
    expect(document.documentElement.dataset.theme).toBe("light");
    dark = true;
    for (const change of mediaChanges) change();
    expect(document.documentElement.dataset.theme).toBe("dark");
    theme.setTheme("sepia");
    dark = false;
    for (const change of mediaChanges) change();
    expect(document.documentElement.dataset.theme).toBe("sepia");
    dark = true;
    theme.setTheme("auto");
    expect(document.documentElement.dataset.theme).toBe("dark");
  });

  it("injects user CSS and exposes its file-stem name", () => {
    theme.installUserThemes([{ name: "custom", css: ':root[data-theme="custom"] { --bg: var(--code-bg); }' }]);
    expect(theme.listThemes()).toContain("custom");
    expect(document.querySelector("style[data-user-theme='custom']")?.textContent).toContain("--bg");
    theme.setTheme("custom");
    expect(document.documentElement.dataset.theme).toBe("custom");
  });

  it("filters fuzzily, previews keyboard selection and reverts on Escape without committing", () => {
    const committed = vi.fn();
    document.addEventListener("mdw-theme-change", committed);
    theme.openThemePicker();
    const input = document.querySelector<HTMLInputElement>(".mdw-theme-picker input")!;
    input.value = "solt";
    input.dispatchEvent(new Event("input"));
    expect(document.querySelectorAll("[role='option']")).toHaveLength(1);
    expect(document.documentElement.dataset.theme).toBe("solarized-light");
    input.value = "";
    input.dispatchEvent(new Event("input"));
    key("n", true);
    expect(document.documentElement.dataset.theme).toBe("light");
    key("ArrowDown");
    expect(document.documentElement.dataset.theme).toBe("dark");
    key("p", true);
    expect(document.documentElement.dataset.theme).toBe("light");
    key("ArrowUp");
    expect(theme.getTheme()).toBe("auto");
    key("Escape");
    expect(theme.getTheme()).toBe("light");
    expect(document.querySelector(".mdw-theme-overlay")).toBeNull();
    expect(committed).not.toHaveBeenCalled();
    document.removeEventListener("mdw-theme-change", committed);
  });

  it("commits the selected theme with Enter", () => {
    const committed = vi.fn();
    document.addEventListener("mdw-theme-change", committed);
    theme.openThemePicker();
    key("ArrowDown");
    key("Enter");
    expect(theme.getTheme()).toBe("dark");
    expect(committed).toHaveBeenCalledOnce();
    document.removeEventListener("mdw-theme-change", committed);
  });

  it("handles Ctrl+Shift+T and Vim :theme", () => {
    const view = new EditorView({
      parent: document.body,
      state: EditorState.create({ extensions: [
        vimExtension({ path: "note.md", dir: ".", save: async () => {}, quit: () => {} }),
        themeExtension(), statusMessage,
      ] }),
    });
    try {
      view.contentDOM.dispatchEvent(new KeyboardEvent("keydown", {
        key: "T", code: "KeyT", keyCode: 84, ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true,
      }));
      expect(document.querySelector(".mdw-theme-overlay")).not.toBeNull();
      key("Escape");
      const cm = getCM(view)! as Parameters<typeof Vim.handleEx>[0];
      Vim.handleEx(cm, "theme nord");
      expect(theme.getTheme()).toBe("nord");
      Vim.handleEx(cm, "theme missing");
      expect(view.state.field(statusMessage)).toContain("Unknown theme");
      Vim.handleEx(cm, "theme");
      expect(document.querySelector(".mdw-theme-overlay")).not.toBeNull();
    } finally { view.destroy(); }
  });
});
