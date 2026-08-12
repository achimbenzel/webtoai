#!/usr/bin/env node
/**
 * Diagnoses why Illustrator is not showing the web2ai panel.
 *
 * CEP fails silently. If a manifest path does not resolve, if PlayerDebugMode
 * is off for the runtime Illustrator actually uses, or if the extension folder
 * is a link the scanner will not follow, the panel simply never appears under
 * Window > Extensions — no error, no log, nothing. This walks the whole chain
 * and names the first thing that is wrong.
 *
 * Usage: pnpm dev:doctor
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { platform } from "node:os";
import { join } from "node:path";
import {
  BUNDLE_ID,
  CSXS_VERSIONS_PROBED,
  distDir,
  extensionsDir,
  installTarget,
  linkKind,
  linkTarget,
  readManifest,
  resolveManifestPath,
  validateExtension,
} from "./cep-paths.mjs";

const findings = [];

const ICON = { ok: "  ok  ", warn: " warn ", fail: " FAIL ", info: "      " };

function line(level, message, detail) {
  console.log(`[${ICON[level]}] ${message}`);
  if (detail !== undefined) console.log(`          ${detail}`);
  if (level === "fail" || level === "warn") findings.push({ level, message });
}

function heading(title) {
  console.log(`\n── ${title} ${"─".repeat(Math.max(0, 58 - title.length))}`);
}

// ── 1. Is the built extension complete? ─────────────────────────────────────

function checkBuild() {
  heading("Build artefact");

  const result = validateExtension(distDir);
  if (!existsSync(distDir)) {
    line("fail", `${distDir} does not exist`, "Run: pnpm --filter @web2ai/cep-extension build");
    return false;
  }

  const manifest = readManifest(distDir);
  if (!manifest.exists) {
    line("fail", "CSXS/manifest.xml is missing", "Run: pnpm --filter @web2ai/cep-extension build");
    return false;
  }

  line("info", `bundle ${manifest.bundleId} (manifest v${manifest.manifestVersion})`);
  line(
    "info",
    `host ${manifest.hostName} ${manifest.hostVersion}, needs CSXS ${manifest.requiredRuntime}`,
  );
  line("info", `menu entry: "${manifest.menu}"`);

  for (const [label, value] of [
    ["MainPath", manifest.mainPath],
    ["ScriptPath", manifest.scriptPath],
  ]) {
    if (value === undefined) continue;
    const resolved = resolveManifestPath(distDir, value);
    if (existsSync(resolved)) {
      const size = statSync(resolved).size;
      line("ok", `${label} ${value} exists (${size} bytes)`);
    } else {
      line(
        "fail",
        `${label} ${value} DOES NOT EXIST`,
        "CEP refuses to list an extension whose resources are missing, without saying so. " +
          "Rebuild: pnpm --filter @web2ai/cep-extension build",
      );
    }
  }

  for (const problem of result.problems) {
    if (!/MainPath|ScriptPath/.test(problem)) line("fail", problem);
  }

  if (result.ok) line("ok", "extension folder is complete");
  return result.ok;
}

// ── 2. Is it installed where CEP looks? ─────────────────────────────────────

function checkInstall() {
  heading("Installation");

  let dir;
  try {
    dir = extensionsDir();
  } catch (error) {
    line("warn", error.message);
    return;
  }

  if (!existsSync(dir)) {
    line("fail", `${dir} does not exist`, "Run: pnpm dev:install");
    return;
  }
  line("info", `extensions folder: ${dir}`);

  const target = installTarget();
  const kind = linkKind(target);

  if (kind === "missing") {
    line("fail", `${BUNDLE_ID} is not installed`, "Run: pnpm dev:install");
    return;
  }

  if (kind === "symlink") {
    line(
      "warn",
      `${BUNDLE_ID} is a symlink -> ${linkTarget(target) ?? "?"}`,
      platform() === "win32"
        ? "CEP's scanner does not reliably follow reparse points on Windows. " +
            "If the panel is still missing, reinstall with: pnpm dev:install --copy"
        : undefined,
    );
  } else if (kind === "directory") {
    // A Windows junction is indistinguishable from a real directory via lstat,
    // so compare against the build folder to tell them apart.
    const looksLinked = !existsSync(join(target, "..", `${BUNDLE_ID}.real`));
    line("info", `${BUNDLE_ID} is a directory${looksLinked ? " (or a junction)" : ""}`);
    if (platform() === "win32") {
      line(
        "info",
        "if this is a junction and the panel does not appear, try: pnpm dev:install --copy",
      );
    }
  } else {
    line("fail", `${target} is a file, not a folder`);
    return;
  }

  // The decisive test: can the resources be reached *through* the install path?
  const manifest = readManifest(target);
  if (!manifest.exists) {
    line("fail", "manifest is not readable through the installed path", target);
    return;
  }
  line("ok", "manifest is readable through the installed path");

  for (const [label, value] of [
    ["MainPath", manifest.mainPath],
    ["ScriptPath", manifest.scriptPath],
  ]) {
    if (value === undefined) continue;
    const resolved = resolveManifestPath(target, value);
    if (existsSync(resolved)) line("ok", `${label} reachable through the installed path`);
    else line("fail", `${label} NOT reachable through the installed path`, resolved);
  }

  // Neighbours are the most useful comparison there is: if the user's own
  // extensions load and ours does not, the difference is visible right here.
  const neighbours = readdirSync(dir).filter((name) => name !== BUNDLE_ID && !name.startsWith("."));
  if (neighbours.length > 0) {
    line("info", `other installed extensions (${neighbours.length}):`);
    for (const name of neighbours.slice(0, 12)) {
      const kindOf = linkKind(join(dir, name));
      const hasManifest = existsSync(join(dir, name, "CSXS", "manifest.xml"));
      console.log(
        `          ${name}  [${kindOf}${hasManifest ? ", has manifest" : ", NO manifest"}]`,
      );
    }
  }
}

// ── 3. Will CEP load an unsigned extension? ─────────────────────────────────

function readPlayerDebugMode(version) {
  const os = platform();
  if (os === "win32") {
    const result = spawnSync(
      "reg.exe",
      ["query", `HKCU\\Software\\Adobe\\CSXS.${version}`, "/v", "PlayerDebugMode"],
      { encoding: "utf8" },
    );
    if (result.error !== undefined) return { state: "error", detail: result.error.message };
    if (result.status !== 0) return { state: "unset" };
    const match = /PlayerDebugMode\s+REG_\w+\s+(\S+)/.exec(result.stdout ?? "");
    return { state: "set", value: match?.[1] ?? "?" };
  }
  if (os === "darwin") {
    const result = spawnSync("defaults", ["read", `com.adobe.CSXS.${version}`, "PlayerDebugMode"], {
      encoding: "utf8",
    });
    if (result.error !== undefined) return { state: "error", detail: result.error.message };
    if (result.status !== 0) return { state: "unset" };
    return { state: "set", value: (result.stdout ?? "").trim() };
  }
  return { state: "n/a" };
}

function checkDebugMode() {
  heading("PlayerDebugMode (required for unsigned extensions)");

  const os = platform();
  if (os !== "win32" && os !== "darwin") {
    line("info", `not applicable on ${os}`);
    return;
  }

  const enabled = [];
  for (const version of CSXS_VERSIONS_PROBED) {
    const result = readPlayerDebugMode(version);
    if (result.state === "set") {
      const on = result.value === "1";
      line(on ? "ok" : "fail", `CSXS.${version}: PlayerDebugMode = ${result.value}`);
      if (on) enabled.push(version);
    } else if (result.state === "error") {
      line("warn", `CSXS.${version}: could not read (${result.detail})`);
    }
  }

  if (enabled.length === 0) {
    line("fail", "PlayerDebugMode is not enabled for any CSXS runtime", "Run: pnpm dev:install");
    return;
  }

  line("info", `enabled for CSXS ${enabled.join(", ")}`);
  line(
    "info",
    "Illustrator reads this from the runtime it actually uses. If your version " +
      "runs on a CSXS not listed above, enable it with: pnpm dev:install --csxs=12,13",
  );
}

// ── 4. Host bundle sanity ───────────────────────────────────────────────────

function checkHostBundle() {
  heading("ExtendScript host bundle");

  const bundle = join(distDir, "host", "index.jsx");
  if (!existsSync(bundle)) {
    line("fail", "dist/host/index.jsx is missing");
    return;
  }

  const source = readFileSync(bundle, "utf8");
  line("ok", `host bundle present (${source.length} bytes)`);

  if (!source.includes("json2.js") && !source.includes("JSON.stringify")) {
    line("warn", "host bundle does not appear to contain json2.js");
  }
  for (const entry of ["web2ai.hello", "web2ai.safeCall"]) {
    if (source.includes(entry)) line("ok", `${entry} is defined`);
    else line("fail", `${entry} is missing from the bundle`);
  }
}

// ── Summary ─────────────────────────────────────────────────────────────────

function summary() {
  heading("Summary");

  const failures = findings.filter((f) => f.level === "fail");
  const warnings = findings.filter((f) => f.level === "warn");

  if (failures.length === 0 && warnings.length === 0) {
    console.log("Everything checks out.\n");
    console.log("If the panel still does not appear under Window > Extensions:");
    console.log("  1. Quit Illustrator completely — it only scans at startup.");
    console.log("  2. Reinstall as a copy instead of a link:  pnpm dev:install --copy");
    console.log("  3. Enable more CEP runtimes:               pnpm dev:install --csxs=11,12,13");
    return;
  }

  for (const finding of failures) console.log(`FAIL  ${finding.message}`);
  for (const finding of warnings) console.log(`warn  ${finding.message}`);

  console.log("");
  if (failures.length > 0) {
    console.log("Fix the FAIL lines above first, then restart Illustrator.");
    process.exitCode = 1;
  } else {
    console.log("No hard failures. Restart Illustrator; if it still does not appear, try");
    console.log("  pnpm dev:install --copy");
  }
}

console.log("web2ai CEP doctor");
const built = checkBuild();
if (built) checkHostBundle();
checkInstall();
checkDebugMode();
summary();
