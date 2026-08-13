import { defineConfig, type Plugin } from "vite";
import { fileURLToPath } from "node:url";

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
    // Kept in step with CSXS/manifest.xml's ExtensionBundleVersion, which CEP
    // reads and which deliberately does not track the npm package version.
    __WEB2AI_VERSION__: JSON.stringify("1.0.0"),
  },
  build: {
    // The panel lands at the extension root, mirroring the layout of Illustrator
    // panels that are known to load: index.html at the top, js/ and css/ beside
    // it. The other build steps write into the same folder afterwards, so this
    // build must not empty it.
    outDir: fileURLToPath(new URL("./dist", import.meta.url)),
    emptyOutDir: false,
    // CEP 11 ships CEF 88.
    target: "chrome88",
    modulePreload: false,
    cssCodeSplit: false,
    // No .map file: it is one more artefact in a folder CEP scans, and the
    // panels that load in the wild ship without one. The panel bundle is small
    // and unminified, so a stack trace is readable as it is.
    sourcemap: false,
    rollupOptions: {
      output: {
        format: "iife",
        inlineDynamicImports: true,
        entryFileNames: "js/panel.js",
        assetFileNames: (asset) =>
          asset.names?.[0]?.endsWith(".css") === true ? "css/style.css" : "assets/[name][extname]",
      },
    },
  },
});
