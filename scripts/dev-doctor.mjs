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
  INSTALL_FOLDER,
  CSXS_VERSIONS_PROBED,
  compareVersions,
  distDir,
  extensionsDir,
  installTarget,
  hostRangeAccepts,
  legacyInstallTargets,
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
  for (const warning of result.warnings ?? []) line("warn", warning);

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

  for (const legacy of legacyInstallTargets()) {
    line(
      "warn",
      `a stale install is still present at ${legacy}`,
      "Two folders declaring the same bundle id. Run: pnpm dev:install",
    );
  }

  const target = installTarget();
  const kind = linkKind(target);

  if (kind === "missing") {
    line("fail", `${INSTALL_FOLDER} is not installed`, "Run: pnpm dev:install");
    return;
  }

  if (kind === "symlink") {
    line(
      "warn",
      `${INSTALL_FOLDER} is a symlink -> ${linkTarget(target) ?? "?"}`,
      platform() === "win32"
        ? "CEP's scanner does not reliably follow reparse points on Windows. " +
            "If the panel is still missing, reinstall with: pnpm dev:install --copy"
        : undefined,
    );
  } else if (kind === "directory") {
    // A Windows junction is indistinguishable from a real directory via lstat,
    // so compare against the build folder to tell them apart.
    const looksLinked = !existsSync(join(target, "..", `${INSTALL_FOLDER}.real`));
    line("info", `${INSTALL_FOLDER} is a directory${looksLinked ? " (or a junction)" : ""}`);
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

  compareWithNeighbours(dir);
}

/**
 * Compares our manifest against the extensions that *do* load.
 *
 * When everything about our own install checks out and the panel is still
 * absent, the remaining causes are all declarative: CEP silently drops an
 * extension whose `<Host>` range excludes the running Illustrator, or whose
 * `RequiredRuntime` asks for a newer CSXS than this Illustrator provides. A
 * neighbour that loads is a working example of what this machine accepts, so
 * the difference between their manifest and ours is the answer.
 */
function compareWithNeighbours(dir) {
  const neighbours = readdirSync(dir).filter(
    (name) => name !== INSTALL_FOLDER && !name.startsWith("."),
  );
  if (neighbours.length === 0) return;

  const ours = readManifest(distDir);
  const rows = [];

  for (const name of neighbours) {
    const manifest = readManifest(join(dir, name));
    if (!manifest.exists) continue;
    rows.push({
      name,
      kind: linkKind(join(dir, name)),
      runtime: manifest.requiredRuntime,
      host: manifest.hostVersion,
      hostName: manifest.hostName,
      debug: existsSync(join(dir, name, ".debug")),
    });
  }

  if (rows.length === 0) return;

  line("info", `extensions that already load here (${rows.length}):`);
  const pad = (value, width) => String(value ?? "?").padEnd(width);
  console.log(`          ${pad("name", 26)} ${pad("CSXS", 6)} ${pad("host range", 18)} .debug`);
  for (const row of rows) {
    console.log(
      `          ${pad(row.name, 26)} ${pad(row.runtime, 6)} ` +
        `${pad(`${row.hostName ?? "?"} ${row.host ?? "?"}`, 18)} ${row.debug ? "yes" : "no"}`,
    );
  }
  console.log(
    `          ${pad("→ web2ai (ours)", 26)} ${pad(ours.requiredRuntime, 6)} ` +
      `${pad(`${ours.hostName ?? "?"} ${ours.hostVersion ?? "?"}`, 18)} ` +
      `${existsSync(join(distDir, ".debug")) ? "yes" : "no"}`,
  );

  // A CSXS requirement above every working neighbour is a strong signal that
  // this Illustrator runs an older CEP than the manifest demands.
  const runtimes = rows.map((row) => row.runtime).filter((value) => value !== undefined);
  const highest = runtimes.reduce(
    (max, value) => (max === undefined || compareVersions(value, max) > 0 ? value : max),
    undefined,
  );
  if (highest !== undefined && compareVersions(ours.requiredRuntime ?? "0", highest) > 0) {
    line(
      "warn",
      `we require CSXS ${ours.requiredRuntime}, but no extension that loads here asks for more than ${highest}`,
      "If this Illustrator runs an older CEP, it drops ours without a word. " +
        "See the host-application check below.",
    );
  }

  // Same reasoning for the host range: a neighbour accepting older Illustrator
  // versions than we do says nothing on its own, but combined with a detected
  // version outside our range it is conclusive.
  const looserHost = rows.find(
    (row) =>
      row.host !== undefined &&
      ours.hostVersion !== undefined &&
      row.host !== ours.hostVersion &&
      /^[[(]/.test(row.host),
  );
  if (looserHost !== undefined) {
    line(
      "info",
      `host ranges differ: ${looserHost.name} accepts ${looserHost.host}, we accept ${ours.hostVersion}`,
    );
  }

  const linked = rows.filter((row) => row.kind === "symlink");
  if (linked.length === 0 && platform() === "win32") {
    line(
      "info",
      "every extension that loads here is a plain folder — none is a link",
      "If the checks above all pass, install a real copy: pnpm dev:install --copy",
    );
  }

  // The folder name is free-form, so it is easy to overlook — and easy to get
  // wrong in a way nothing else reveals. If every extension that loads uses a
  // plain name and ours does not, say so.
  const dotted = rows.filter((row) => row.name.includes("."));
  if (dotted.length === 0 && INSTALL_FOLDER.includes(".")) {
    line(
      "warn",
      `our folder is "${INSTALL_FOLDER}", but no extension that loads here has a dot in its name`,
      "Rename the installed folder to something plain and restart Illustrator.",
    );
  }
}

// ── 2c. Diff against a manifest known to work ───────────────────────────────

/**
 * Compares our manifest field by field against one that is known to load.
 *
 * When the install is provably fine, the cause is in the manifest, and the
 * fastest way to find it is a working example. Point this at any extension
 * folder — or at a manifest.xml directly — that Illustrator does list:
 *
 *   pnpm dev:doctor --reference "C:\\path\\to\\GridHandler"
 */
function checkReference(referencePath) {
  heading("Comparison with a manifest known to load");

  const root = referencePath.replace(/[\\/]CSXS[\\/]manifest\.xml$/i, "");
  const theirs = readManifest(root);
  if (!theirs.exists) {
    line("fail", `no CSXS/manifest.xml under ${root}`);
    return;
  }

  const ours = readManifest(distDir);
  const fields = [
    ["ExtensionManifest Version", ours.manifestVersion, theirs.manifestVersion],
    ["Host", `${ours.hostName} ${ours.hostVersion}`, `${theirs.hostName} ${theirs.hostVersion}`],
    ["RequiredRuntime CSXS", ours.requiredRuntime, theirs.requiredRuntime],
    [
      "CEFCommandLine",
      (ours.cefParameters ?? []).join(" ") || "(empty)",
      (theirs.cefParameters ?? []).join(" ") || "(empty)",
    ],
    [".debug present", existsSync(join(distDir, ".debug")), existsSync(join(root, ".debug"))],
  ];

  let differences = 0;
  for (const [label, mine, theirsValue] of fields) {
    if (String(mine) === String(theirsValue)) {
      line("ok", `${label}: same (${mine})`);
      continue;
    }
    differences += 1;
    line("warn", `${label} differs`, `ours: ${mine}   |   works: ${theirsValue}`);
  }

  // The resource paths almost always differ — different projects lay their
  // files out differently. What matters is whether they resolve, not whether
  // they match, so a differing-but-working path is not reported as a candidate.
  for (const [label, mine, theirsValue] of [
    ["MainPath", ours.mainPath, theirs.mainPath],
    ["ScriptPath", ours.scriptPath, theirs.scriptPath],
  ]) {
    const mineOk = mine !== undefined && existsSync(resolveManifestPath(distDir, mine));
    const theirsOk =
      theirsValue !== undefined && existsSync(resolveManifestPath(root, theirsValue));
    if (mineOk) {
      line(
        "ok",
        `${label}: ${mine} resolves (theirs: ${theirsValue}${theirsOk ? "" : ", missing"})`,
      );
    } else {
      differences += 1;
      line("fail", `${label}: ${mine} does not resolve`, `theirs, which works: ${theirsValue}`);
    }
  }

  if (differences === 0) {
    line("ok", "the two manifests agree on every field that affects loading");
  } else {
    line(
      "info",
      `${differences} manifest field(s) differ; each one is a candidate. RequiredRuntime ` +
        "and CEFCommandLine are the two that most often decide it.",
    );
  }

  compareStructure(root);
}

/**
 * Compares the file tree and encodings, not just the manifest.
 *
 * A field-by-field manifest diff misses everything that is not a field: the
 * folder name, the file layout, text encodings, line endings. Those are
 * exactly the things that are invisible when reading the XML and decisive
 * when CEP scans the directory.
 */
function compareStructure(root) {
  const list = (base) => {
    const out = [];
    const walk = (dir, prefix) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
        if (entry.isDirectory()) walk(join(dir, entry.name), rel);
        else out.push(rel);
      }
    };
    walk(base, "");
    return out.sort();
  };

  const theirs = list(root);
  const ours = list(distDir);

  const onlyOurs = ours.filter((name) => !theirs.includes(name));
  const onlyTheirs = theirs.filter((name) => !ours.includes(name));

  line("info", `file tree: ours ${ours.length} file(s), reference ${theirs.length}`);
  if (onlyOurs.length > 0) line("info", `only in ours:      ${onlyOurs.join(", ")}`);
  if (onlyTheirs.length > 0) line("info", `only in reference: ${onlyTheirs.join(", ")}`);

  // Folder name — free-form, therefore easy to get wrong silently.
  const referenceFolder = root.split(/[\\/]/).filter(Boolean).pop() ?? "?";
  if (referenceFolder.includes(".") === INSTALL_FOLDER.includes(".")) {
    line("ok", `folder name shape matches (ours "${INSTALL_FOLDER}", theirs "${referenceFolder}")`);
  } else {
    line(
      "warn",
      `folder name shape differs: ours "${INSTALL_FOLDER}", theirs "${referenceFolder}"`,
      "CEP takes the extension's identity from the manifest, not the folder, but a " +
        "reverse-DNS folder name is not what working panels use.",
    );
  }

  // Encodings and line endings, for the files both sides have.
  for (const name of ours.filter((file) => theirs.includes(file))) {
    const mine = readFileSync(join(distDir, name));
    const theirsBytes = readFileSync(join(root, name));
    const nonAscii = (buffer) => buffer.some((byte) => byte > 127);
    if (nonAscii(mine) && !nonAscii(theirsBytes)) {
      line(
        "warn",
        `${name}: ours is non-ASCII, the reference is pure ASCII`,
        name.endsWith(".jsx")
          ? "ExtendScript reads .jsx as ASCII unless told otherwise."
          : undefined,
      );
    }
  }
}

// ── 2b. Which Illustrator is installed? ─────────────────────────────────────

function installedIllustratorVersions() {
  const os = platform();

  if (os === "win32") {
    const found = new Set();
    for (const key of [
      "HKLM\\SOFTWARE\\Adobe\\Illustrator",
      "HKLM\\SOFTWARE\\WOW6432Node\\Adobe\\Illustrator",
    ]) {
      const result = spawnSync("reg.exe", ["query", key], { encoding: "utf8" });
      if (result.status !== 0) continue;
      for (const match of (result.stdout ?? "").matchAll(/\\Illustrator\\([\d]+\.[\d]+)/g)) {
        if (match[1] !== undefined) found.add(match[1]);
      }
    }
    return [...found].sort(compareVersions);
  }

  if (os === "darwin") {
    try {
      // /Applications/Adobe Illustrator 2024 — the folder carries the year,
      // which is 2021 → 25.0, 2022 → 26.0, and so on.
      return readdirSync("/Applications")
        .map((name) => /^Adobe Illustrator (\d{4})$/.exec(name)?.[1])
        .filter((year) => year !== undefined)
        .map((year) => `${Number(year) - 1996}.0`)
        .sort(compareVersions);
    } catch {
      return [];
    }
  }

  return [];
}

function checkHostApplication() {
  heading("Host application");

  const versions = installedIllustratorVersions();
  if (versions.length === 0) {
    line("info", "could not detect an installed Illustrator — skipping the version check");
    return;
  }

  const ours = readManifest(distDir);
  line("info", `Illustrator version(s) found: ${versions.join(", ")}`);
  line("info", `manifest accepts ${ours.hostName} ${ours.hostVersion}`);

  const accepted = versions.filter(
    (version) => hostRangeAccepts(ours.hostVersion, version) === true,
  );
  if (accepted.length > 0) {
    line("ok", `${accepted.join(", ")} falls inside the manifest's host range`);
    return;
  }

  line(
    "fail",
    `no installed Illustrator falls inside the manifest range ${ours.hostVersion}`,
    `Illustrator ${versions.join(", ")} is outside it, so CEP will never list this panel. ` +
      "Widen <Host Version> in apps/cep-extension/CSXS/manifest.xml — note that CEP 11 " +
      "features (Node in the panel) need Illustrator 25.0 or newer.",
  );
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

  // Follow the manifest rather than hardcoding a path, so the check cannot
  // drift when the extension layout changes.
  const scriptPath = readManifest(distDir).scriptPath;
  if (scriptPath === undefined) {
    line("fail", "the manifest declares no <ScriptPath>");
    return;
  }
  const bundle = resolveManifestPath(distDir, scriptPath);
  if (!existsSync(bundle)) {
    line("fail", `${scriptPath} is missing`);
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
    printRemainingSteps();
    return;
  }

  for (const finding of failures) console.log(`FAIL  ${finding.message}`);
  for (const finding of warnings) console.log(`warn  ${finding.message}`);

  console.log("");
  if (failures.length > 0) {
    console.log("Fix the FAIL lines above first, then restart Illustrator.");
    process.exitCode = 1;
    return;
  }
  console.log("No hard failures.");
  printRemainingSteps();
}

/**
 * What is left when every automated check passes.
 *
 * Ordered by how often each one turns out to be the answer, and each is a
 * single command so they can be worked through quickly. Quitting Illustrator
 * between attempts is not optional — it only scans extensions at startup.
 */
function printRemainingSteps() {
  const debugFile = join(installTarget(), ".debug");
  console.log("");
  console.log("Remaining things to try, quitting Illustrator fully between each:");
  console.log("");
  console.log("  1. Install a real folder instead of a link:");
  console.log("       pnpm dev:install --copy");
  console.log("");
  console.log("  2. Take the .debug file out of the equation — CEP's reader for it");
  console.log("     is strict, and a file it dislikes costs the whole extension:");
  console.log(`       rename ${debugFile} to .debug.off`);
  console.log("");
  console.log("  3. Enable PlayerDebugMode for further CEP runtimes:");
  console.log("       pnpm dev:install --csxs=9,10,11,12,13");
  console.log("");
  console.log("  4. Compare against one that works: copy a loading extension's folder,");
  console.log("     swap in our CSXS/manifest.xml, and see whether it disappears. That");
  console.log("     isolates the manifest from everything else.");
}

const referenceArg = process.argv.slice(2).find((arg) => arg.startsWith("--reference"));
const referencePath =
  referenceArg === undefined
    ? undefined
    : referenceArg.includes("=")
      ? referenceArg.slice(referenceArg.indexOf("=") + 1)
      : process.argv[process.argv.indexOf(referenceArg) + 1];

console.log("web2ai CEP doctor");
const built = checkBuild();
if (built) checkHostBundle();
checkInstall();
if (referencePath !== undefined && referencePath !== "") checkReference(referencePath);
checkHostApplication();
checkDebugMode();
summary();
