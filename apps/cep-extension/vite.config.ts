import { defineConfig, type Plugin } from "vite";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

const here = fileURLToPath(new URL(".", import.meta.url));
const pkg = JSON.parse(readFileSync(`${here}package.json`, "utf8")) as { version: string };

/**
 * CEP panels are loaded from a `file://` URL. Chromium refuses to fetch ES
 * modules over `file://` (opaque origin ⇒ CORS failure), so the panel is
 * emitted as a single classic IIFE script and the module attributes that Vite
 * writes into index.html are stripped again here.
 *
 * `type="module"` is swapped for `defer` rather than simply dropped: Vite puts
 * the script tag in <head>, and a classic non-deferred script there runs before
 * <body> is parsed, so every getElementById in main.ts would return null.
 */
function classicScriptTags(): Plugin {
  return {
    name: "web2ai:classic-script-tags",
    enforce: "post",
    transformIndexHtml(html) {
      return html
        .replace(/\s+type="module"/g, " defer")
        .replace(/\s+crossorigin(?:="[^"]*")?/g, "")
        .replace(/<link[^>]+rel="modulepreload"[^>]*>/g, "");
    },
  };
}

export default defineConfig({
  root: fileURLToPath(new URL("./client", import.meta.url)),
  base: "./",
  plugins: [classicScriptTags()],
  define: {
    __WEB2AI_VERSION__: JSON.stringify(pkg.version),
  },
  build: {
    outDir: fileURLToPath(new URL("./dist/client", import.meta.url)),
    emptyOutDir: true,
    // CEP 11 ships CEF 88.
    target: "chrome88",
    modulePreload: false,
    cssCodeSplit: false,
    sourcemap: true,
    rollupOptions: {
      output: {
        format: "iife",
        inlineDynamicImports: true,
        entryFileNames: "assets/panel.js",
        assetFileNames: "assets/[name][extname]",
      },
    },
  },
});
