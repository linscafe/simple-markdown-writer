import { Prec, type Extension } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags } from "@lezer/highlight";
import { Vim } from "@replit/codemirror-vim";
import { showMessage } from "./document";
import "./themes/light.css";
import "./themes/dark.css";
import "./themes/solarized-light.css";
import "./themes/solarized-dark.css";
import "./themes/nord.css";
import "./themes/gruvbox-dark.css";
import "./themes/dracula.css";
import "./themes/sepia.css";
import "./themes/tokyonight-night.css";
import "./themes/tokyonight-storm.css";
import "./themes/tokyonight-day.css";
import "./themes/catppuccin-mocha.css";
import "./themes/catppuccin-macchiato.css";
import "./themes/catppuccin-frappe.css";
import "./themes/catppuccin-latte.css";
import "./themes/gruvbox-light.css";
import "./themes/kanagawa-wave.css";
import "./themes/kanagawa-dragon.css";
import "./themes/kanagawa-lotus.css";
import "./themes/rose-pine.css";
import "./themes/rose-pine-moon.css";
import "./themes/rose-pine-dawn.css";
import "./themes/nightfox.css";
import "./themes/dayfox.css";
import "./themes/carbonfox.css";
import "./themes/onedark.css";
import "./themes/onelight.css";
import "./themes/everforest-dark.css";
import "./themes/everforest-light.css";
import "./themes/sonokai.css";
import "./themes/github-dark.css";
import "./themes/github-light.css";
import "./themes/material-oceanic.css";
import "./themes/material-palenight.css";
import "./themes/monokai.css";
import "./themes/ayu-dark.css";
import "./themes/ayu-mirage.css";
import "./themes/ayu-light.css";
import "./themes/oxocarbon.css";
import "./themes/nightfly.css";
import "./themes/moonfly.css";
import "./themes/papercolor-light.css";
import "./themes/papercolor-dark.css";
import "./theme.css";

const builtins = [
  "light", "dark", "solarized-light", "solarized-dark", "nord", "gruvbox-dark", "dracula", "sepia",
  "tokyonight-night", "tokyonight-storm", "tokyonight-day",
  "catppuccin-mocha", "catppuccin-macchiato", "catppuccin-frappe", "catppuccin-latte", "gruvbox-light",
  "kanagawa-wave", "kanagawa-dragon", "kanagawa-lotus", "rose-pine", "rose-pine-moon", "rose-pine-dawn",
  "nightfox", "dayfox", "carbonfox", "onedark", "onelight", "everforest-dark", "everforest-light", "sonokai",
  "github-dark", "github-light", "material-oceanic", "material-palenight", "monokai",
  "ayu-dark", "ayu-mirage", "ayu-light", "oxocarbon", "nightfly", "moonfly",
  "papercolor-light", "papercolor-dark",
];
const userThemes = new Map<string, HTMLStyleElement>();
let selectedTheme = "auto";
let media: MediaQueryList | undefined;
let closePicker: (() => void) | undefined;

export function listThemes(): string[] {
  return ["auto", ...new Set([...builtins, ...userThemes.keys()])];
}

export function getTheme(): string { return selectedTheme; }

function resolveTheme(): void {
  document.documentElement.dataset.theme = selectedTheme === "auto"
    ? (media?.matches ? "dark" : "light") : selectedTheme;
}

function applyTheme(name: string): void {
  if (!listThemes().includes(name)) throw new Error(`Unknown theme: ${name}`);
  if (!media && typeof window.matchMedia === "function") {
    media = window.matchMedia("(prefers-color-scheme: dark)");
    media.addEventListener("change", resolveTheme);
  }
  selectedTheme = name;
  resolveTheme();
}

export function setTheme(name: string): void {
  applyTheme(name);
  document.dispatchEvent(new CustomEvent("mdw-theme-change", { detail: name }));
}

export function installUserThemes(themes: { name: string; css: string }[]): void {
  for (const style of userThemes.values()) style.remove();
  userThemes.clear();
  for (const { name, css } of themes) {
    if (name === "auto") continue;
    const style = document.createElement("style");
    style.dataset.userTheme = name;
    style.textContent = css;
    document.head.append(style);
    userThemes.set(name, style);
  }
}

export function fuzzyMatch(name: string, query: string): boolean {
  let position = 0;
  const normalized = name.toLowerCase();
  for (const character of query.toLowerCase().trim()) {
    position = normalized.indexOf(character, position);
    if (position < 0) return false;
    position++;
  }
  return true;
}

export function openThemePicker(): void {
  if (closePicker) return;
  const original = selectedTheme;
  const previousFocus = document.activeElement;
  const overlay = document.createElement("div");
  overlay.className = "mdw-theme-overlay";
  const dialog = document.createElement("div");
  dialog.className = "mdw-theme-picker";
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-label", "Choose theme");
  dialog.setAttribute("aria-modal", "true");
  const input = document.createElement("input");
  input.placeholder = "Filter themes…";
  input.setAttribute("aria-label", "Filter themes");
  input.setAttribute("role", "combobox");
  input.setAttribute("aria-controls", "mdw-theme-list");
  input.setAttribute("aria-expanded", "true");
  input.autocomplete = "off";
  const list = document.createElement("div");
  list.id = "mdw-theme-list";
  list.setAttribute("role", "listbox");
  dialog.append(input, list);
  overlay.append(dialog);
  document.body.append(overlay);
  let names = listThemes();
  let index = names.indexOf(original);

  function close(commit: boolean): void {
    overlay.remove();
    closePicker = undefined;
    if (commit && names[index]) setTheme(names[index]);
    else applyTheme(original);
    if (previousFocus instanceof HTMLElement) previousFocus.focus();
  }
  closePicker = () => close(false);

  function render(): void {
    list.replaceChildren();
    if (names.length) applyTheme(names[index]);
    else applyTheme(original);
    names.forEach((name, itemIndex) => {
      const item = document.createElement("div");
      item.id = `mdw-theme-${itemIndex}`;
      item.className = "mdw-theme-option";
      item.setAttribute("role", "option");
      item.setAttribute("aria-selected", String(itemIndex === index));
      item.textContent = name;
      item.addEventListener("pointermove", () => {
        if (index === itemIndex) return;
        index = itemIndex;
        render();
      });
      item.addEventListener("click", () => { index = itemIndex; close(true); });
      list.append(item);
    });
    const active = list.children[index];
    if (active) {
      input.setAttribute("aria-activedescendant", active.id);
      active.scrollIntoView?.({ block: "nearest" });
    } else {
      input.removeAttribute("aria-activedescendant");
      list.textContent = "No matching themes";
    }
  }
  input.addEventListener("input", () => {
    names = listThemes().filter((name) => fuzzyMatch(name, input.value));
    index = 0;
    render();
  });
  overlay.addEventListener("keydown", (event) => {
    event.stopPropagation();
    if (event.key === "Escape") { event.preventDefault(); close(false); }
    else if (event.key === "Enter") { event.preventDefault(); close(true); }
    else if (event.key === "Tab") { event.preventDefault(); input.focus(); }
    else if (event.key === "ArrowDown" || event.key === "ArrowUp" ||
      (event.ctrlKey && (event.key === "n" || event.key === "p"))) {
      event.preventDefault();
      if (names.length) {
        const direction = event.key === "ArrowDown" || event.key === "n" ? 1 : -1;
        index = (index + direction + names.length) % names.length;
        render();
      }
    }
  });
  overlay.addEventListener("mousedown", (event) => { if (event.target === overlay) close(false); });
  render();
  input.focus();
}

Vim.defineEx("theme", "theme", (cm, params) => {
  const name = params.argString?.trim();
  if (!name) openThemePicker();
  else {
    try { setTheme(name); }
    catch (error) { (cm.cm6 as EditorView).dispatch({ effects: showMessage.of(String(error)) }); }
  }
});

const highlightStyle = HighlightStyle.define([
  { tag: [tags.keyword, tags.operator, tags.modifier], color: "var(--accent)" },
  { tag: [tags.string, tags.regexp], color: "var(--code-fg)" },
  { tag: [tags.number, tags.bool, tags.null], color: "var(--code-number, var(--h3))" },
  { tag: [tags.function(tags.variableName), tags.typeName, tags.className], color: "var(--code-function, var(--h2))" },
  { tag: [tags.comment, tags.meta], color: "var(--muted)", fontStyle: "italic" },
  { tag: [tags.variableName, tags.propertyName], color: "var(--fg)" },
  { tag: tags.invalid, color: "var(--accent)", textDecoration: "underline wavy" },
]);

export function themeExtension(): Extension {
  return [
    syntaxHighlighting(highlightStyle),
    Prec.highest(keymap.of([{
      key: "Ctrl-Shift-t", run: () => { openThemePicker(); return true; }, preventDefault: true,
    }])),
  ];
}
