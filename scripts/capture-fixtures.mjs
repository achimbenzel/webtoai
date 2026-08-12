#!/usr/bin/env node
/**
 * Regenerates fixtures/<name>/expected-scene.json by running the real walker
 * against the real layout engine.
 *
 * The walker's unit tests drive a synthetic DOM, which is right for asserting
 * behaviour but cannot tell you whether the parsers actually match what Chrome
 * computes. These fixtures close that gap: Chromium lays the page out, the
 * standalone capture bundle walks it, and the result is committed so that
 * `pnpm test` can check it without needing a browser.
 *
 * Usage:
 *   node scripts/capture-fixtures.mjs [name ...] [--check]
 *
 *   --check   do not write; fail if the committed scene is out of date
 */
import { readdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { pathToFileURL } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const fixturesDir = join(repoRoot, "fixtures");
const bundlePath = join(repoRoot, "apps", "chrome-extension", "dist", "capture-standalone.js");

/** Fixed so that regenerating a fixture produces no spurious diff. */
const CAPTURED_AT = "2026-01-01T00:00:00.000Z";
const VIEWPORT = { width: 1280, height: 800 };

const args = process.argv.slice(2);
const check = args.includes("--check");
const only = args.filter((arg) => !arg.startsWith("--"));

function log(message) {
  console.log(`[fixtures] ${message}`);
}

/**
 * Playwright ships a browser revision that may not match what is installed on
 * the machine, so the binary is located explicitly.
 */
async function resolveChromium() {
  const explicit = process.env.WEB2AI_CHROMIUM;
  if (explicit !== undefined && existsSync(explicit)) return explicit;

  const base = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (base === undefined || !existsSync(base)) return undefined;

  for (const entry of await readdir(base)) {
    if (!entry.startsWith("chromium")) continue;
    for (const candidate of [
      join(base, entry, "chrome-linux", "chrome"),
      join(base, entry, "chrome-mac", "Chromium.app", "Contents", "MacOS", "Chromium"),
      join(base, entry, "chrome-win", "chrome.exe"),
    ]) {
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

async function fixtureNames() {
  const entries = await readdir(fixturesDir, { withFileTypes: true });
  const all = entries
    .filter(
      (entry) => entry.isDirectory() && existsSync(join(fixturesDir, entry.name, "index.html")),
    )
    .map((entry) => entry.name)
    .sort();
  return only.length === 0 ? all : all.filter((name) => only.includes(name));
}

/**
 * The scene records where it came from; a local file path would make the
 * committed fixture machine-specific.
 */
function normalise(scene, name) {
  return {
    ...scene,
    source: {
      ...scene.source,
      url: `fixture://${name}/index.html`,
      capturedAt: CAPTURED_AT,
    },
  };
}

async function main() {
  if (!existsSync(bundlePath)) {
    console.error(
      `[fixtures] ${bundlePath} is missing.\n` +
        `[fixtures] Run: pnpm --filter @web2ai/chrome-extension build`,
    );
    process.exitCode = 1;
    return;
  }

  const executablePath = await resolveChromium();
  if (executablePath === undefined) {
    console.error(
      "[fixtures] No Chromium found. Set WEB2AI_CHROMIUM to a browser binary, or install\n" +
        "[fixtures] Playwright's browsers with: npx playwright install chromium",
    );
    process.exitCode = 1;
    return;
  }
  log(`chromium: ${executablePath}`);

  const { chromium } = await import("playwright-core");
  const bundle = await readFile(bundlePath, "utf8");
  const browser = await chromium.launch({ executablePath, args: ["--no-sandbox"] });

  let failures = 0;
  try {
    const context = await browser.newContext({
      viewport: VIEWPORT,
      deviceScaleFactor: 1,
      // Fixtures must not depend on the host's fonts or motion settings.
      reducedMotion: "reduce",
    });

    for (const name of await fixtureNames()) {
      const page = await context.newPage();
      const fixturePath = join(fixturesDir, name, "index.html");
      await page.goto(pathToFileURL(fixturePath).href, { waitUntil: "load" });
      await page.evaluate(() => document.fonts.ready);

      await page.addScriptTag({ content: bundle });
      const result = await page.evaluate((capturedAt) => {
        const capture = window.__web2aiCapture;
        if (capture === undefined) throw new Error("capture bundle did not install itself");
        return capture({ capturedAt, embedImages: false });
      }, CAPTURED_AT);

      const scene = normalise(result.scene, name);
      const payload = `${JSON.stringify(scene, null, 2)}\n`;
      const target = join(fixturesDir, name, "expected-scene.json");

      if (check) {
        const current = existsSync(target) ? await readFile(target, "utf8") : "";
        if (current !== payload) {
          console.error(`[fixtures] ${name}: expected-scene.json is out of date`);
          failures += 1;
        } else {
          log(`${name}: up to date`);
        }
      } else {
        await writeFile(target, payload, "utf8");
        const degraded = result.log.filter((row) => row.level !== "info").length;
        log(
          `${name}: ${countNodes(scene.root)} nodes, ${result.assetRequests.length} asset(s), ` +
            `${degraded} degradation kind(s)`,
        );
      }

      await page.close();
    }
  } finally {
    await browser.close();
  }

  if (failures > 0) process.exitCode = 1;
}

function countNodes(node) {
  return 1 + node.children.reduce((sum, child) => sum + countNodes(child), 0);
}

await main();
