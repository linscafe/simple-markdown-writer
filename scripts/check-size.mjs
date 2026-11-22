#!/usr/bin/env node
// Fails when the JavaScript loaded at startup (entry chunk plus its static imports) exceeds the budget.
import { readFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const budget = 400 * 1000;
const dist = join(dirname(fileURLToPath(import.meta.url)), "..", "dist");
const html = readFileSync(join(dist, "index.html"), "utf8");
const entries = [...html.matchAll(/<script[^>]+type="module"[^>]+src="\/?([^"]+)"/g)].map((match) => match[1]);
if (!entries.length) {
  console.error("size: no module entry found in dist/index.html; run `npm run build` first");
  process.exit(1);
}

const seen = new Set();
const queue = [...entries];
while (queue.length) {
  const file = queue.shift();
  if (seen.has(file)) continue;
  seen.add(file);
  const source = readFileSync(join(dist, file), "utf8");
  for (const match of source.matchAll(/(?:\bimport|\bfrom)\s*["'](\.{1,2}\/[^"']+\.js)["']/g)) {
    queue.push(posix.normalize(posix.join(posix.dirname(file), match[1])));
  }
}

let total = 0;
for (const file of seen) {
  const size = gzipSync(readFileSync(join(dist, file))).length;
  total += size;
  console.log(`${(size / 1000).toFixed(2).padStart(9)} kB gzip  ${file}`);
}
console.log(`${(total / 1000).toFixed(2).padStart(9)} kB gzip  startup JS total (budget ${budget / 1000} kB)`);
if (total > budget) {
  console.error("size: startup JS exceeds budget");
  process.exit(1);
}
