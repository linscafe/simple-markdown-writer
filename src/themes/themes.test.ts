import { describe, expect, it } from "vitest";
import { listThemes } from "../theme";

const files = import.meta.glob<string>("./*.css", { query: "?raw", import: "default", eager: true });

const required = [
  "bg", "fg", "muted", "error", "accent", "cursor", "selection", "line-active", "link", "code-bg", "code-fg",
  "quote-border", "hr", "table-border", "h1", "h2", "h3", "h4", "h5", "h6", "font-body", "font-mono", "font-size",
];
const optionalColors = ["code-function", "code-number"];

const contrastFloors: Record<string, { reason: string; fg: number; muted: number }> = {
  "solarized-light": { reason: "upstream Solarized base00 body text", fg: 4.0, muted: 2.9 },
};
const defaultFloor = { fg: 4.5, muted: 3 };

function parse(css: string): { id: string; scheme: string; vars: Map<string, string> } {
  const id = /:root\[data-theme="([^"]+)"\]/.exec(css)?.[1] ?? "";
  const scheme = /color-scheme:\s*(light|dark)\s*;/.exec(css)?.[1] ?? "";
  const vars = new Map([...css.matchAll(/--([a-z0-9-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
  return { id, scheme, vars };
}

function luminance(color: string): number {
  const match = /^#([0-9a-f]{6})$/i.exec(color);
  if (!match) throw new Error(`Not a #rrggbb color: ${color}`);
  const [r, g, b] = [0, 2, 4].map((i) => {
    const c = parseInt(match[1].slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
}

const themes = Object.entries(files).map(([path, css]) => ({ stem: path.replace(/^\.\/|\.css$/g, ""), ...parse(css) }));

describe("built-in theme files", () => {
  it("are all registered as built-ins", () => {
    expect(themes.length).toBeGreaterThan(0);
    expect(listThemes()).toEqual(expect.arrayContaining(themes.map((theme) => theme.stem)));
  });

  it("only lists contrast exceptions for existing themes", () => {
    expect(themes.map((theme) => theme.stem)).toEqual(expect.arrayContaining(Object.keys(contrastFloors)));
  });

  it("computes WCAG contrast ratios", () => {
    expect(contrast("#000000", "#ffffff")).toBeCloseTo(21);
    expect(contrast("#777777", "#ffffff")).toBeCloseTo(4.48, 2);
  });

  for (const { stem, id, scheme, vars } of themes) {
    describe(stem, () => {
      it("targets its own id and declares a color scheme", () => {
        expect(id).toBe(stem);
        expect(["light", "dark"]).toContain(scheme);
      });

      it("defines every required variable", () => {
        expect(required.filter((name) => !vars.get(name))).toEqual([]);
      });

      it("uses valid colors for the optional code variables", () => {
        for (const name of optionalColors) {
          const value = vars.get(name);
          if (value !== undefined) expect(value, name).toMatch(/^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i);
        }
      });

      it("keeps body text and muted text readable", () => {
        const bg = vars.get("bg") ?? "";
        const floor = contrastFloors[stem] ?? defaultFloor;
        expect(contrast(vars.get("fg") ?? "", bg)).toBeGreaterThanOrEqual(floor.fg);
        expect(contrast(vars.get("muted") ?? "", bg)).toBeGreaterThanOrEqual(floor.muted);
      });
    });
  }
});
