#!/usr/bin/env node
/**
 * Installs the web2ai CEP panel for development.
 *
 * Two things have to be true before Illustrator will load an unsigned panel:
 *
 *  1. The extension folder must live in a CEP extensions directory. We create a
 *     *symlink* to apps/cep-extension/dist so that a rebuild is picked up by
 *     simply reopening the panel — no reinstall.
 *  2. PlayerDebugMode must be 1, otherwise CEP silently refuses to load an
 *     extension whose signature it cannot verify.
 *       macOS:   defaults write com.adobe.CSXS.11 PlayerDebugMode 1
 *       Windows: HKCU\Software\Adobe\CSXS.11 /v PlayerDebugMode REG_SZ 1
 *
 * There is a single cross-platform implementation instead of a .sh/.ps1 pair so
 * the two platforms cannot drift apart.
 *
 * Usage:
 *   node scripts/dev-install.mjs [--uninstall] [--csxs=11,12] [--copy] [--dry-run]
 *
 * Env:
 *   WEB2AI_CEP_EXTENSIONS_DIR   override the target directory (used by tests)
 */
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const sourceDir = join(repoRoot, "apps", "cep-extension", "dist");
const BUNDLE_ID = "com.web2ai.cep";

const args = process.argv.slice(2);
const flags = {
  uninstall: args.includes("--uninstall"),
  copy: args.includes("--copy"),
  dryRun: args.includes("--dry-run"),
  csxs: readCsxsVersions(args),
};

function readCsxsVersions(argv) {
  const arg = argv.find((a) => a.startsWith("--csxs="));
  // CEP 11 is the runtime this extension targets (Illustrator CC 2021+).
  if (arg === undefined) return ["11"];
  return arg
    .slice("--csxs=".length)
    .split(",")
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
}

function log(message) {
  console.log(`[dev-install] ${message}`);
}

/** Read from the one config file rather than repeating the port here. */
function debugPort() {
  const config = JSON.parse(readFileSync(join(repoRoot, "config", "web2ai.config.json"), "utf8"));
  return config.debug.cepRemoteDebugPort;
}

function fail(message) {
  console.error(`[dev-install] ${message}`);
  process.exitCode = 1;
}

/** Per-user CEP extensions directory for the current platform. */
function extensionsDir() {
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
      `Set WEB2AI_CEP_EXTENSIONS_DIR to install anyway.`,
  );
}

function setPlayerDebugMode(enabled) {
  const value = enabled ? "1" : "0";
  const os = platform();

  for (const version of flags.csxs) {
    let command;
    let commandArgs;
    if (os === "darwin") {
      command = "defaults";
      commandArgs = ["write", `com.adobe.CSXS.${version}`, "PlayerDebugMode", value];
    } else if (os === "win32") {
      command = "reg";
      commandArgs = [
        "add",
        `HKCU\\Software\\Adobe\\CSXS.${version}`,
        "/v",
        "PlayerDebugMode",
        "/t",
        "REG_SZ",
        "/d",
        value,
        "/f",
      ];
    } else {
      log(`skipping PlayerDebugMode on ${os} (macOS/Windows only)`);
      return;
    }

    if (flags.dryRun) {
      log(`would run: ${command} ${commandArgs.join(" ")}`);
      continue;
    }

    const result = spawnSync(command, commandArgs, { stdio: "inherit" });
    if (result.status === 0) {
      log(`PlayerDebugMode=${value} for CSXS.${version}`);
    } else {
      fail(`failed to set PlayerDebugMode for CSXS.${version} (exit ${result.status})`);
    }
  }

  if (os === "darwin" && enabled && !flags.dryRun) {
    // macOS caches preference domains; without this Illustrator can keep
    // reading the old value until the next login.
    spawnSync("killall", ["cfprefsd"], { stdio: "ignore" });
  }
}

function removeTarget(target) {
  if (!existsSync(target) && !isSymlink(target)) return false;
  if (flags.dryRun) {
    log(`would remove ${target}`);
    return true;
  }
  rmSync(target, { recursive: true, force: true });
  return true;
}

function isSymlink(path) {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

function install() {
  if (!existsSync(sourceDir)) {
    fail(`${sourceDir} does not exist — run \`pnpm --filter @web2ai/cep-extension build\` first.`);
    return;
  }

  const dir = extensionsDir();
  const target = join(dir, BUNDLE_ID);

  if (flags.dryRun) {
    log(`would install ${sourceDir} -> ${target}`);
  } else {
    mkdirSync(dir, { recursive: true });
    if (isSymlink(target)) {
      log(`replacing existing symlink (was -> ${readlinkSync(target)})`);
    }
    removeTarget(target);

    if (flags.copy) {
      cpSync(sourceDir, target, { recursive: true });
      log(`copied ${sourceDir} -> ${target}`);
    } else {
      // "junction" is the Windows link type that does not need admin rights.
      symlinkSync(sourceDir, target, platform() === "win32" ? "junction" : "dir");
      log(`symlinked ${sourceDir} -> ${target}`);
    }
  }

  setPlayerDebugMode(true);

  log("");
  log("Done. Next steps:");
  log("  1. Restart Adobe Illustrator (a running instance will not rescan).");
  log("  2. Open Window > Extensions > web2ai.");
  log(`  3. Remote debugging: http://localhost:${debugPort()} while the panel is open.`);
}

function uninstall() {
  const dir = extensionsDir();
  const target = join(dir, BUNDLE_ID);
  const removed = removeTarget(target);
  log(removed ? `removed ${target}` : `nothing installed at ${target}`);
  log("PlayerDebugMode was left enabled; pass --csxs and run with --uninstall-debug to reset.");
  if (args.includes("--uninstall-debug")) setPlayerDebugMode(false);
}

function main() {
  try {
    if (flags.uninstall) uninstall();
    else install();
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}

main();
