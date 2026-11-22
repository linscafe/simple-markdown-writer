import { defineConfig } from "vitest/config";

const markdownHtmlStub = new URL("./src/stubs/lang-html.ts", import.meta.url).pathname;

export default defineConfig({
  clearScreen: false,
  plugins: [{
    name: "markdown-without-html",
    enforce: "pre",
    resolveId(source, importer) {
      if (source === "@codemirror/lang-html" && importer?.includes("/@codemirror/lang-markdown/")) return markdownHtmlStub;
      return null;
    },
  }],
  optimizeDeps: { exclude: ["@codemirror/lang-markdown"] },
  server: {
    port: 1420,
    strictPort: true,
    watch: { ignored: ["**/src-tauri/**"] },
  },
  test: { environment: "jsdom", css: { include: [/\/src\/themes\/[^/]+\.css/] } },
});
