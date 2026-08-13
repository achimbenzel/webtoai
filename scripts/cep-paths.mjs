/**
 * Shared knowledge about where the CEP extension lives and what a complete
 * one looks like.
 *
 * Both `dev-install.mjs` and `dev-doctor.mjs` import this, so the installer
 * and the diagnostic can never disagree about which folder to look in or which
 * files are required.
 */
import { existsSync, lstatSync, readFileSync, readlinkSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
export const distDir = join(repoRoot, "apps", "cep-extension", "dist");
export const BUNDLE_ID = "com.web2ai.cep";

/** CSXS runtimes worth touching: 11 is what we target, 12 is what newer Illustrator ships. */
export const CSXS_VERSIONS = ["11", "12"];

/** Every CSXS runtime a diagnostic should look at, not just the ones we set. */
export const CSXS_VERSIONS_PROBED = ["9", "10", "11", "12", "13"];

/** Per-user CEP extensions directory for the current platform. */
export function extensionsDir() {
  const override = process.env.WEB2AI_CEP_EXTENSIONS_DIR;
  if (override !== undefined && override !== "") return resolve(override);

  const os = platform();
  if (os === "darwin") {
    return join(homedir(), "Library", "Application Support", "Adobe", "CEP", "extensions");
  }
  if (os === "win32") {
    const appData = process.env.APPDATA;
    if (appData === undefined) throw new Error("APPDATA is not set");
    return join(appData, "Adobe", "CEP", "extensions");
  }
  throw new Error(
    `CEP extensions are only supported on macOS and Windows (this is ${os}). ` +
      `Set WEB2AI_CEP_EXTENSIONS_DIR to work with one anyway.`,
  );
}

export function installTarget() {
  return join(extensionsDir(), BUNDLE_ID);
}

/** "symlink" | "junction-or-directory" | "missing". Windows junctions report as directories. */
export function linkKind(path) {
  try {
    const stats = lstatSync(path);
    if (stats.isSymbolicLink()) return "symlink";
    if (stats.isDirectory()) return "directory";
    return "file";
  } catch {
    return "missing";
  }
}

export function linkTarget(path) {
  try {
    return readlinkSync(path);
  } catch {
    return undefined;
  }
}

/**
 * Reads the fields of our own manifest that decide whether CEP will load it.
 *
 * Regex rather than an XML parser: this is a file we generate ourselves in a
 * known shape, and a dependency-free build is worth more here than generality.
 */
export function readManifest(root = distDir) {
  const path = join(root, "CSXS", "manifest.xml");
  if (!existsSync(path)) return { path, exists: false };

  const xml = readFileSync(path, "utf8");
  const one = (pattern) => {
    const match = pattern.exec(xml);
    return match?.[1];
  };
  const all = (pattern) => [...xml.matchAll(pattern)].map((match) => match[1]);

  return {
    path,
    exists: true,
    bundleId: one(/ExtensionBundleId="([^"]+)"/),
    manifestVersion: one(/<ExtensionManifest[^>]*\sVersion="([^"]+)"/),
    extensionIds: all(/<Extension\s+Id="([^"]+)"/g),
    mainPath: one(/<MainPath>([^<]+)<\/MainPath>/),
    scriptPath: one(/<ScriptPath>([^<]+)<\/ScriptPath>/),
    hostName: one(/<Host\s+Name="([^"]+)"/),
    hostVersion: one(/<Host\s+Name="[^"]+"\s+Version="([^"]+)"/),
    requiredRuntime: one(/<RequiredRuntime\s+Name="CSXS"\s+Version="([^"]+)"/),
    cefParameters: all(/<Parameter>([^<]+)<\/Parameter>/g),
    menu: one(/<Menu>([^<]+)<\/Menu>/),
  };
}

/** Resolves a manifest `./client/index.html` style path against a root. */
export function resolveManifestPath(root, manifestPath) {
  return join(root, manifestPath.replace(/^\.\//, ""));
}

/** Compares dotted version strings: -1, 0 or 1. */
export function compareVersions(a, b) {
  const left = String(a).split(".").map(Number);
  const right = String(b).split(".").map(Number);
  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i += 1) {
    const l = left[i] ?? 0;
    const r = right[i] ?? 0;
    if (l < r) return -1;
    if (l > r) return 1;
  }
  return 0;
}

/**
 * Whether a manifest `<Host Version="…">` range accepts a host version.
 *
 * The range is CEP's own notation: `[25.0,99.9]` inclusive, `(25.0,99.9)`
 * exclusive, or a bare minimum like `25.0`.
 */
export function hostRangeAccepts(range, version) {
  if (range === undefined || version === undefined) return undefined;

  const bounded = /^([[(])\s*([\d.]+)\s*,\s*([\d.]+)\s*([\])])$/.exec(range.trim());
  if (bounded !== null) {
    const [, open, min, max, close] = bounded;
    const lowOk =
      open === "[" ? compareVersions(version, min) >= 0 : compareVersions(version, min) > 0;
    const highOk =
      close === "]" ? compareVersions(version, max) <= 0 : compareVersions(version, max) < 0;
    return lowOk && highOk;
  }

  if (/^[\d.]+$/.test(range.trim())) return compareVersions(version, range.trim()) >= 0;
  return undefined;
}

/**
 * Checks that a folder is a *complete* extension.
 *
 * This is the check that matters most in practice: CEP silently refuses to
 * list an extension whose MainPath or ScriptPath does not resolve, with no
 * error anywhere. A half-finished build — say, one where the panel bundle step
 * failed after the manifest was already written — looks completely normal on
 * disk and simply never appears in Illustrator.
 */
export function validateExtension(root = distDir) {
  const problems = [];

  if (!existsSync(root)) {
    return { ok: false, problems: [`${root} does not exist — the extension has not been built`] };
  }

  const manifest = readManifest(root);
  if (!manifest.exists) {
    return { ok: false, problems: [`${manifest.path} is missing`] };
  }

  for (const [label, value] of [
    ["MainPath", manifest.mainPath],
    ["ScriptPath", manifest.scriptPath],
  ]) {
    if (value === undefined) {
      problems.push(`manifest has no <${label}>`);
      continue;
    }
    const resolved = resolveManifestPath(root, value);
    if (!existsSync(resolved)) {
      problems.push(`<${label}> points at ${value}, which does not exist (${resolved})`);
    }
  }

  const ids = new Set(manifest.extensionIds);
  if (ids.size === 0) problems.push("manifest declares no <Extension Id=…>");
  if (manifest.extensionIds.length >= 2 && ids.size !== 1) {
    problems.push(`ExtensionList and DispatchInfoList use different ids: ${[...ids].join(", ")}`);
  }

  for (const required of ["--enable-nodejs", "--mixed-context"]) {
    if (!(manifest.cefParameters ?? []).includes(required)) {
      problems.push(`CEFCommandLine is missing ${required}`);
    }
  }

  if (!existsSync(join(root, "config", "web2ai.config.json"))) {
    problems.push("config/web2ai.config.json was not copied into the extension");
  }

  return { ok: problems.length === 0, problems, manifest };
}
