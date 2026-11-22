// Replaces @codemirror/lang-html for @codemirror/lang-markdown only (see vite.config.ts).
// Without an HTML parser, inline HTML in Markdown is left unparsed instead of loading the HTML, CSS and JS grammars at startup.
export function html(): { support: []; language: { parser: undefined } } {
  return { support: [], language: { parser: undefined } };
}

export function htmlCompletionSource(): null {
  return null;
}
