#!/usr/bin/env node
/**
 * Assembles the installable CEP extension into apps/cep-extension/dist.
 *
 * Layout produced (this folder is what gets symlinked by scripts/dev-install
 * and what gets packed into a .zxp in milestone 5):
 *
 *   dist/
 *   ├── CSXS/manifest.xml
 *   ├── index.html             Vite build of the panel UI
 *   ├── js/panel.js
 *   ├── css/style.css
 *   ├── jsx/host.jsx           json2.js + all host/*.jsx concatenated
 *   └── config/                copy of the repo-root config/, read by the host
 *
 * The layout deliberately mirrors Illustrator panels that are known to load:
 * index.html at the extension root with js/ and css/ beside it, rather than a
 * client/ subfolder. CEP gives no diagnostics when it rejects an extension, so
 * staying close to a shape that demonstrably works is worth more than a tidier
 * tree.
 *
 * The host bundle is produced by plain concatenation rather than ExtendScript's
 * `#include`, so the file that ships is exactly the file we linted, and no
 * path resolution happens at runtime.
 *
 * Flags:
 *   --enable-node    fill in CEFCommandLine with --enable-nodejs and
 *                    --mixed-context. Off by default: an empty CEFCommandLine
 *                    matches the reference panel, and these switches are one of
 *                    the few remaining differences when a panel will not load.
 *                    Milestone 2's transport server needs them.
 *   --debug-file     write .debug for remote debugging. Off by default for the
 *                    same reason — CEP's reader for it is strict, and panels
 *                    that load in the wild generally ship without one.
 *   --watch          rebuild the panel UI on change.
 */
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";

const appDir = dirname(dirname(fileURLToPath(import.meta.url)));
const repoRoot = dirname(dirname(appDir));
const distDir = join(appDir, "dist");

const watch = process.argv.includes("--watch");
const enableNode = process.argv.includes("--enable-node");
const debugFile = process.argv.includes("--debug-file");

/** Order matters: json2.js first, then host sources by filename prefix. */
const HOST_BANNER = `/*
 * web2ai ExtendScript host bundle — GENERATED, do not edit.
 * Sources: apps/cep-extension/host/*.jsx  (see scripts/build.mjs)
 * ES3 only. Any ES5+ token here breaks the entire bundle at parse time.
 */
`;

function log(message) {
  console.log(`[cep-build] ${message}`);
}

function buildHostBundle() {
  const hostDir = join(appDir, "host");
  const parts = [HOST_BANNER, readFileSync(join(hostDir, "lib", "json2.js"), "utf8")];

  const sources = readdirSync(hostDir)
    .filter((name) => name.endsWith(".jsx"))
    .sort();
  if (sources.length === 0) throw new Error("No host/*.jsx sources found");

  for (const name of sources) {
    parts.push(`\n\n// ==== ${name} ${"=".repeat(Math.max(0, 60 - name.length))}\n`);
    parts.push(readFileSync(join(hostDir, name), "utf8"));
  }

  mkdirSync(join(distDir, "jsx"), { recursive: true });
  writeFileSync(join(distDir, "jsx", "host.jsx"), parts.join(""), "utf8");
  log(`host bundle: ${sources.length} source(s) + json2.js -> jsx/host.jsx`);
}

function extensionId(manifest) {
  const match = manifest.match(/<Extension\s+Id="([^"]+)"/);
  if (match === null) throw new Error("Could not read the extension Id from CSXS/manifest.xml");
  return match[1];
}

function buildManifest() {
  const source = readFileSync(join(appDir, "CSXS", "manifest.xml"), "utf8");

  // The checked-in manifest carries an empty <CEFCommandLine/>, matching a
  // panel that is known to load. --enable-node fills it in.
  const manifest = enableNode
    ? source.replace(
        /<CEFCommandLine\s*\/>/,
        "<CEFCommandLine>\n            <Parameter>--enable-nodejs</Parameter>\n" +
          "            <Parameter>--mixed-context</Parameter>\n          </CEFCommandLine>",
      )
    : source;

  mkdirSync(join(distDir, "CSXS"), { recursive: true });
  writeFileSync(join(distDir, "CSXS", "manifest.xml"), manifest, "utf8");
  log(`CSXS/manifest.xml written (Node ${enableNode ? "enabled" : "disabled"})`);
  return manifest;
}

function buildDebugFile(manifest) {
  if (!debugFile) {
    log(".debug omitted (pass --debug-file to enable remote debugging)");
    return;
  }
  const config = JSON.parse(readFileSync(join(repoRoot, "config", "web2ai.config.json"), "utf8"));
  const port = config.debug.cepRemoteDebugPort;

  // No comment before the root element: CEP's reader for this file is stricter
  // than a general XML parser.
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<ExtensionList>
  <Extension Id="${extensionId(manifest)}">
    <HostList>
      <Host Name="ILST" Port="${port}" />
    </HostList>
  </Extension>
</ExtensionList>
`;
  writeFileSync(join(distDir, ".debug"), xml, "utf8");
  log(`.debug written (remote debugging on http://localhost:${port})`);
}

function copyConfig() {
  cpSync(join(repoRoot, "config"), join(distDir, "config"), { recursive: true });
  log("copied config/");
}

async function buildClient() {
  await build({
    configFile: join(appDir, "vite.config.ts"),
    build: watch ? { watch: {} } : {},
  });
}

async function main() {
  rmSync(distDir, { recursive: true, force: true });
  mkdirSync(distDir, { recursive: true });

  // The panel build writes into dist/ directly, so it runs first and the
  // remaining steps add to the same folder.
  await buildClient();

  const manifest = buildManifest();
  buildHostBundle();
  buildDebugFile(manifest);
  copyConfig();

  log(`extension assembled at ${distDir}`);
  log("run `pnpm dev:install --copy` to install it");
}

await main();
