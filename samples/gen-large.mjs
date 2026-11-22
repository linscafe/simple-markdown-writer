#!/usr/bin/env node
// Usage: node samples/gen-large.mjs [output.md | --stdout] [lines]
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const sections = [
  (n) => [
    `## Section ${n}`,
    "",
    `Paragraph ${n} with **bold**, *italic*, ~~strike~~, \`code\`, a [link](https://example.com/${n}) and <https://example.org/${n}>.`,
    `Inline math $a_${n} + b^2 = c$ next to a relative [note](notes/${n}.md) and a [heading](#section-${n}).`,
    "",
  ],
  (n) => [
    `- Bullet ${n}`,
    "  - Nested bullet with *emphasis*",
    `- [ ] Task ${n}`,
    "- [x] Done task",
    "",
    "1. First",
    "2. Second",
    "",
  ],
  (n) => [
    "| Column A | Column B | Right |",
    "|----------|:--------:|------:|",
    ...Array.from({ length: 6 }, (_, row) => `| a${n}-${row} | **b${row}** | ${row * n} |`),
    "",
  ],
  (n) => [
    "```ts",
    `function f${n}(x: number): number {`,
    "  const doubled = x * 2;",
    "  return doubled + 1;",
    "}",
    "```",
    "",
  ],
  (n) => [
    "$$",
    `\\int_0^{${n}} x^2\\,dx = \\frac{${n}^3}{3}`,
    "$$",
    "",
    `![Image ${n}](large.assets/image-${n % 10}.png) and an embed ![[image-${n % 10}.png|120]]`,
    "",
  ],
  (n) => [
    `> Quote ${n} with **bold** text.`,
    "> Second line of the quote.",
    "",
    "---",
    "",
  ],
];

export function generateLarge(lines = 10000) {
  const out = ["# Large document", ""];
  for (let n = 0; out.length < lines; n++) out.push(...sections[n % sections.length](n));
  return out.slice(0, lines).join("\n") + "\n";
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const target = process.argv[2] ?? fileURLToPath(new URL("large.md", import.meta.url));
  const text = generateLarge(Number(process.argv[3] ?? 10000));
  if (target === "--stdout") process.stdout.write(text);
  else {
    writeFileSync(target, text);
    console.error(`wrote ${target}`);
  }
}
