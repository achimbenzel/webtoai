#!/usr/bin/env node
/**
 * Installs the web2ai CEP panel for development.
 *
 * Three things have to be true before Illustrator will load an unsigned panel:
 *
 *  1. The built extension must be *complete*. CEP silently refuses to list an
 *     extension whose MainPath or ScriptPath does not resolve — no error, no
 *     log, it just never appears under Window > Extensions. A half-finished
 *     build looks entirely normal on disk, so it is checked before installing.
 *  2. The folder must live in a CEP extensions directory. We create a symlink
 *     to apps/cep-extension/dist so a rebuild is picked up by reopening the
 *     panel. Windows is the exception: CEP's scanner does not reliably follow
 *     reparse points there, so `--copy` exists for it.
 *  3. PlayerDebugMode must be 1 for the CSXS runtime Illustrator actually
 *     uses, otherwise CEP refuses anything it cannot verify a signature for.
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
 *
 * See also: pnpm dev:doctor, which diagnoses a panel that will not appear.
 */
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { platform } from "node:os";
import { join } from "node:path";
import {
  CSXS_VERSIONS,
  distDir as sourceDir,
  extensionsDir,
  installTarget,
  linkKind,
  linkTarget,
  repoRoot,
  validateExtension,
} from "./cep-paths.mjs";

const args = process.argv.slice(2);
const flags = {
  uninstall: args.includes("--uninstall"),
  copy: args.includes("--copy"),
  dryRun: args.includes("--dry-run"),
  csxs: readCsxsVersions(args),
};

function readCsxsVersions(argv) {
  const arg = argv.find((a) => a.startsWith("--csxs="));
  // CEP 11 is the runtime this extension targets, but newer Illustrator
  // releases run on CSXS 12 and read PlayerDebugMode from *that* key. Setting
  // both costs nothing and removes the single most common reason for a panel
  // that never shows up.
  if (arg === undefined) return [...CSXS_VERSIONS];
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
      // Spelled out with the extension: Node's spawn does not apply PATHEXT
      // the way a shell does, so a bare "reg" is not guaranteed to resolve.
      command = "reg.exe";
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
    if (result.error !== undefined) {
      // A null status means the process never started at all — say which
      // command could not be run rather than reporting "exit null".
      fail(`could not run \`${command}\`: ${result.error.message}`);
    } else if (result.status === 0) {
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
  if (linkKind(target) === "missing") return false;
  if (flags.dryRun) {
    log(`would remove ${target}`);
    return true;
  }
  rmSync(target, { recursive: true, force: true });
  return true;
}

function install() {
  if (!existsSync(sourceDir)) {
    fail(`${sourceDir} does not exist — run \`pnpm --filter @web2ai/cep-extension build\` first.`);
    return;
  }

  // Installing an incomplete extension is worse than not installing it: CEP
  // drops it without a word, and the only symptom is a panel that is simply
  // absent from the menu. Refuse here, where we can say what is missing.
  const validation = validateExtension(sourceDir);
  if (!validation.ok) {
    fail("the built extension is incomplete, refusing to install it:");
    for (const problem of validation.problems) console.error(`[dev-install]   - ${problem}`);
    console.error(
      "[dev-install] Rebuild with: pnpm --filter @web2ai/cep-extension build\n" +
        "[dev-install] Then diagnose with: pnpm dev:doctor",
    );
    return;
  }

  const dir = extensionsDir();
  const target = installTarget();

  if (flags.dryRun) {
    log(`would install ${sourceDir} -> ${target}`);
  } else {
    mkdirSync(dir, { recursive: true });
    const existing = linkKind(target);
    if (existing === "symlink") {
      log(`replacing existing symlink (was -> ${linkTarget(target) ?? "?"})`);
    } else if (existing !== "missing") {
      log(`replacing existing ${existing}`);
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

  // Verify through the installed path, not the source: on Windows a junction
  // can exist and still not give CEP's scanner what it needs.
  if (!flags.dryRun) {
    const throughLink = validateExtension(target);
    if (throughLink.ok) {
      log("verified: the extension is complete when read through the install path");
    } else {
      fail("installed, but the extension is not readable through the install path:");
      for (const problem of throughLink.problems) console.error(`[dev-install]   - ${problem}`);
      if (!flags.copy) {
        console.error("[dev-install] Try installing a copy instead: pnpm dev:install --copy");
      }
    }
  }

  log("");
  log("Done. Next steps:");
  log("  1. Quit Adobe Illustrator completely — it only scans extensions at startup.");
  log("  2. Open Window > Extensions > web2ai.");
  if (existsSync(join(target, ".debug"))) {
    log(`  3. Remote debugging: http://localhost:${debugPort()} while the panel is open.`);
  } else {
    log("  3. Remote debugging is off; rebuild with --debug-file to enable it.");
  }
  log("");
  log("Panel missing from the menu? Run: pnpm dev:doctor");
}

function uninstall() {
  const target = installTarget();
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
