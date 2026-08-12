#!/usr/bin/env node
/**
 * Builds the unpacked MV3 extension into apps/chrome-extension/dist.
 *
 * Three separate bundles, because MV3 puts three different constraints on them:
 *
 *   background.js  classic service worker — one self-contained file, no imports
 *   content.js     injected via chrome.scripting; must be a single classic
 *                  script, as content scripts cannot be ES modules
 *   popup.js       an extension page; bundled the same way for consistency
 *
 * All three are emitted as IIFEs for that reason. `--zip` additionally packs
 * dist/ for the Chrome Web Store.
 */
import { createWriteStream } from "node:fs";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { renderIcons } from "./make-icons.mjs";

const appDir = dirname(dirname(fileURLToPath(import.meta.url)));
const repoRoot = dirname(dirname(appDir));
const srcDir = join(appDir, "src");
const distDir = join(appDir, "dist");

const watch = process.argv.includes("--watch");
const zip = process.argv.includes("--zip");

const pkg = JSON.parse(await readFile(join(appDir, "package.json"), "utf8"));

function log(message) {
  console.log(`[chrome-build] ${message}`);
}

/** One IIFE bundle per entry point. */
async function bundle(name, entry, extraOutput = {}) {
  await build({
    root: appDir,
    configFile: false,
    logLevel: "warn",
    define: { __WEB2AI_VERSION__: JSON.stringify(pkg.version) },
    resolve: {
      alias: { "@web2ai/schema": join(repoRoot, "packages", "schema", "src", "index.ts") },
    },
    build: {
      outDir: distDir,
      emptyOutDir: false,
      // Chrome 116 is the manifest's declared minimum.
      target: "chrome116",
      sourcemap: true,
      minify: false,
      lib: {
        entry,
        formats: ["iife"],
        // The IIFE global name must be a legal JS identifier, so hyphens in the
        // bundle name cannot go through as-is.
        name: `web2ai_${name.replace(/-/g, "_")}`,
        fileName: () => `${name}.js`,
      },
      rollupOptions: { output: { ...extraOutput } },
      watch: watch ? {} : null,
    },
  });
  log(`bundled ${name}.js`);
}

async function copyStatic() {
  const manifest = JSON.parse(await readFile(join(appDir, "manifest.json"), "utf8"));
  manifest.version = pkg.version;
  await writeFile(join(distDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  await cp(join(srcDir, "popup", "index.html"), join(distDir, "popup.html"));
  await cp(join(srcDir, "popup", "popup.css"), join(distDir, "popup.css"));
  log("copied manifest.json, popup.html, popup.css");
}

async function writeIcons() {
  const iconsDir = join(distDir, "icons");
  await mkdir(iconsDir, { recursive: true });
  for (const { size, png } of renderIcons()) {
    await writeFile(join(iconsDir, `icon-${size}.png`), png);
  }
  log("generated icons");
}

/**
 * Minimal store-deflate zip writer. The alternative is pulling in an archiver
 * dependency for one build step that runs on a handful of small files.
 */
async function packZip() {
  const { deflateRawSync } = await import("node:zlib");
  const { readdir, stat } = await import("node:fs/promises");

  async function listFiles(dir, prefix = "") {
    const out = [];
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      const name = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) out.push(...(await listFiles(full, name)));
      else if (!entry.name.endsWith(".map"))
        out.push({ full, name, size: (await stat(full)).size });
    }
    return out;
  }

  const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
    return table;
  })();
  const crc32 = (buffer) => {
    let crc = 0xffffffff;
    for (const byte of buffer) crc = (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
  };

  const files = await listFiles(distDir);
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const file of files) {
    const content = await readFile(file.full);
    const compressed = deflateRawSync(content, { level: 9 });
    const nameBytes = Buffer.from(file.name, "utf8");
    const crc = crc32(content);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt32LE(0, 10); // dos time/date: fixed for reproducible builds
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(content.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    locals.push(local, nameBytes, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(0, 12);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(content.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBytes);

    offset += local.length + nameBytes.length + compressed.length;
  }

  const centralBuffer = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBuffer.length, 12);
  end.writeUInt32LE(offset, 16);

  const target = join(appDir, `web2ai-chrome-${pkg.version}.zip`);
  await new Promise((resolve, reject) => {
    const stream = createWriteStream(target);
    stream.on("error", reject);
    stream.on("finish", resolve);
    stream.end(Buffer.concat([...locals, centralBuffer, end]));
  });
  log(`packed ${target}`);
}

async function main() {
  await rm(distDir, { recursive: true, force: true });
  await mkdir(distDir, { recursive: true });

  await copyStatic();
  await writeIcons();

  await bundle("background", join(srcDir, "background", "index.ts"));
  await bundle("content", join(srcDir, "content", "index.ts"));
  await bundle("popup", join(srcDir, "popup", "main.ts"), {
    assetFileNames: "popup-[name][extname]",
  });
  // Not referenced by the manifest: used by the fixture harness and for
  // debugging the walker from a DevTools console.
  await bundle("capture-standalone", join(srcDir, "standalone", "index.ts"));

  if (zip) await packZip();

  log(`extension built at ${distDir}`);
  log("load it via chrome://extensions → Developer mode → Load unpacked");
}

await main();
