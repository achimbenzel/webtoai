#!/usr/bin/env node
/**
 * Assembles the installable CEP extension into apps/cep-extension/dist.
 *
 * Layout produced (this folder is what gets symlinked by scripts/dev-install
 * and what gets packed into a .zxp in milestone 5):
 *
 *   dist/
 *   ├── .debug                 generated from config/web2ai.config.json
 *   ├── CSXS/manifest.xml
 *   ├── client/                Vite build of the panel UI
 *   ├── config/                copy of the repo-root config/, read by the host
 *   └── host/index.jsx         json2.js + all host/*.jsx concatenated
 *
 * The host bundle is produced by plain concatenation rather than ExtendScript's
 * `#include`, so the file that ships is exactly the file we linted, and no
 * path resolution happens at runtime.
 */
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const appDir = dirname(dirname(fileURLToPath(import.meta.url)));
const repoRoot = dirname(dirname(appDir));
const distDir = join(appDir, "dist");

const watch = process.argv.includes("--watch");

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

  mkdirSync(join(distDir, "host"), { recursive: true });
  writeFileSync(join(distDir, "host", "index.jsx"), parts.join(""), "utf8");
  log(`host bundle: ${sources.length} source(s) + json2.js`);
  return sources;
}

function buildDebugFile() {
  const config = JSON.parse(readFileSync(join(repoRoot, "config", "web2ai.config.json"), "utf8"));
  const manifest = readFileSync(join(appDir, "CSXS", "manifest.xml"), "utf8");
  const idMatch = manifest.match(/<Extension\s+Id="([^"]+)"/);
  if (idMatch === null) throw new Error("Could not read the extension Id from CSXS/manifest.xml");
  const port = config.debug.cepRemoteDebugPort;

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!-- GENERATED from config/web2ai.config.json (debug.cepRemoteDebugPort). -->
<ExtensionList>
  <Extension Id="${idMatch[1]}">
    <HostList>
      <Host Name="ILST" Port="${port}" />
    </HostList>
  </Extension>
</ExtensionList>
`;
  writeFileSync(join(distDir, ".debug"), xml, "utf8");
  log(`.debug written (remote debugging on http://localhost:${port})`);
}

function copyStaticFiles() {
  mkdirSync(join(distDir, "CSXS"), { recursive: true });
  cpSync(join(appDir, "CSXS", "manifest.xml"), join(distDir, "CSXS", "manifest.xml"));
  cpSync(join(repoRoot, "config"), join(distDir, "config"), { recursive: true });
  log("copied CSXS/manifest.xml and config/");
}

function buildClient() {
  const viteBin = join(repoRoot, "node_modules", ".bin", "vite");
  const args = ["build", "--config", join(appDir, "vite.config.ts")];
  if (watch) args.push("--watch");
  const result = spawnSync(viteBin, args, { stdio: "inherit", cwd: appDir });
  if (result.status !== 0) {
    throw new Error(`vite build failed with exit code ${result.status}`);
  }
}

function main() {
  rmSync(distDir, { recursive: true, force: true });
  mkdirSync(distDir, { recursive: true });

  copyStaticFiles();
  buildHostBundle();
  buildDebugFile();
  buildClient();

  log(`extension assembled at ${distDir}`);
  log("run `pnpm dev:install` to symlink it into the CEP extensions folder");
}

main();
