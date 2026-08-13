import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createContext, runInContext } from "node:vm";
import { beforeAll, describe, expect, it } from "vitest";

/**
 * Runs the real ExtendScript host in a sandbox.
 *
 * The host is ES3, and ES3 is a subset of what Node executes — so the actual
 * shipped source can be evaluated here against fake `File`, `Folder`, `app`
 * and `$` objects. That covers the parts of the host that are pure logic
 * (scene validation, statistics, path handling) without Illustrator, which is
 * the only way they get tested at all before milestone 3.
 */

const hostDir = fileURLToPath(new URL("../host", import.meta.url));
const fixturesDir = fileURLToPath(new URL("../../../fixtures", import.meta.url));

interface SceneSummary {
  path: string;
  url: string;
  nodeCount: number;
  maxDepth: number;
  textCount: number;
  imageCount: number;
  degraded: number;
  assetCount: number;
  fontCount: number;
  reasons: Array<{ code: string; count: number }>;
}

interface HostNamespace {
  VERSION: string;
  SCHEMA_VERSION: number;
  trim(text: string): string;
  indexOf(list: unknown[], value: unknown): number;
  safeCall(fn: () => unknown): string;
  setExtensionRoot(path: string): string;
  extensionRoot(): string;
  checkScene(scene: unknown): string[];
  sceneStats(root: unknown): {
    nodeCount: number;
    maxDepth: number;
    textCount: number;
    imageCount: number;
    degraded: number;
    reasons: Array<{ code: string; count: number }>;
  };
  loadSceneFile(path: string): SceneSummary;
  hello(extensionRoot?: string): string;
  openScene(): string;
}

/** Concatenates the host exactly as scripts/build.mjs does. */
function hostBundle(): string {
  const sources = readdirSync(hostDir)
    .filter((name) => name.endsWith(".jsx"))
    .sort();
  return [
    readFileSync(join(hostDir, "lib", "json2.js"), "utf8"),
    ...sources.map((name) => readFileSync(join(hostDir, name), "utf8")),
  ].join("\n\n");
}

/** Minimal stand-ins for the ExtendScript globals the host touches. */
function createSandbox(files: Record<string, string>): Record<string, unknown> {
  class FakeFile {
    readonly fsName: string;
    private cursor = 0;
    encoding = "UTF-8";

    constructor(path: string) {
      this.fsName = path;
    }

    get exists(): boolean {
      return this.fsName in files;
    }

    get parent(): { exists: boolean; create(): boolean; fsName: string } {
      const parent = this.fsName.replace(/[/\\][^/\\]*$/, "");
      return { exists: true, create: () => true, fsName: parent };
    }

    open(): boolean {
      this.cursor = 0;
      return this.exists;
    }

    read(): string {
      return files[this.fsName] ?? "";
    }

    write(text: string): boolean {
      files[this.fsName] = text;
      return true;
    }

    close(): boolean {
      return true;
    }
  }

  const sandbox: Record<string, unknown> = {
    File: FakeFile,
    Folder: class {
      readonly fsName: string;
      static temp = { fsName: "/tmp" };
      constructor(path: string) {
        this.fsName = path;
      }
      get exists(): boolean {
        return true;
      }
      create(): boolean {
        return true;
      }
    },
    app: { name: "Adobe Illustrator", version: "29.6.1" },
    $: { locale: "en_US", engineName: "transient", fileName: "/Applications/Illustrator" },
  };
  return sandbox;
}

let files: Record<string, string>;
let host: HostNamespace;

function loadHost(): void {
  files = {};
  const sandbox = createSandbox(files);
  createContext(sandbox);
  runInContext(hostBundle(), sandbox);
  host = sandbox["web2ai"] as HostNamespace;
}

beforeAll(loadHost);

describe("host bundle evaluates", () => {
  it("defines the namespace and its version", () => {
    expect(host).toBeDefined();
    expect(host.SCHEMA_VERSION).toBe(1);
  });

  it("provides the ES3 replacements for missing built-ins", () => {
    expect(host.trim("  padded  ")).toBe("padded");
    expect(host.indexOf(["a", "b", "c"], "b")).toBe(1);
    expect(host.indexOf(["a"], "z")).toBe(-1);
  });
});

describe("safeCall", () => {
  it("wraps a result in an ok envelope", () => {
    expect(JSON.parse(host.safeCall(() => 42))).toEqual({ ok: true, value: 42 });
  });

  it("turns a throw into structured JSON rather than an opaque failure", () => {
    const envelope = JSON.parse(
      host.safeCall(() => {
        throw new Error("boom");
      }),
    ) as { ok: boolean; error: string };
    expect(envelope.ok).toBe(false);
    expect(envelope.error).toBe("boom");
  });
});

describe("extension root", () => {
  it("refuses to guess when the panel has not supplied it", () => {
    loadHost();
    expect(() => host.extensionRoot()).toThrow(/Extension root unknown/);
  });

  it("stores what the panel passes in and strips a trailing separator", () => {
    loadHost();
    host.setExtensionRoot("C:\\Users\\me\\AppData\\Roaming\\Adobe\\CEP\\extensions\\web2ai\\");
    expect(host.extensionRoot()).toBe(
      "C:\\Users\\me\\AppData\\Roaming\\Adobe\\CEP\\extensions\\web2ai",
    );
  });

  it("ignores an empty path instead of blanking a good one", () => {
    loadHost();
    host.setExtensionRoot("/real/path");
    host.setExtensionRoot("");
    expect(host.extensionRoot()).toBe("/real/path");
  });
});

describe("hello", () => {
  it("reports the config as failed, with the reason, when it cannot be read", () => {
    loadHost();
    const envelope = JSON.parse(host.hello("/nowhere")) as {
      ok: boolean;
      value: { configLoaded: boolean; configError: string; extensionRoot: string };
    };
    expect(envelope.ok).toBe(true);
    expect(envelope.value.configLoaded).toBe(false);
    expect(envelope.value.configError).toContain("File not found");
    expect(envelope.value.extensionRoot).toBe("/nowhere");
  });

  it("loads the config from the root the panel supplies", () => {
    loadHost();
    files["/ext/config/web2ai.config.json"] = readFileSync(
      fileURLToPath(new URL("../../../config/web2ai.config.json", import.meta.url)),
      "utf8",
    );
    const envelope = JSON.parse(host.hello("/ext")) as {
      value: { configLoaded: boolean; renderMaxLayerDepth: number };
    };
    expect(envelope.value.configLoaded).toBe(true);
    expect(envelope.value.renderMaxLayerDepth).toBeGreaterThanOrEqual(1);
  });
});

describe("checkScene", () => {
  it("accepts a real captured scene", () => {
    const scene = JSON.parse(
      readFileSync(join(fixturesDir, "landing-page", "expected-scene.json"), "utf8"),
    );
    expect(host.checkScene(scene)).toEqual([]);
  });

  it("rejects a file that is not a scene", () => {
    expect(host.checkScene({ hello: "world" }).length).toBeGreaterThan(0);
    expect(host.checkScene(null)).toEqual(["The file does not contain a JSON object."]);
  });

  it("names a schema version it cannot render", () => {
    const problems = host.checkScene({ version: 2, source: {}, root: {}, assets: [], fonts: [] });
    expect(problems.join(" ")).toContain("Unsupported schema version");
  });
});

describe("sceneStats", () => {
  it("counts a real scene the same way the capture side does", () => {
    const scene = JSON.parse(
      readFileSync(join(fixturesDir, "landing-page", "expected-scene.json"), "utf8"),
    );
    const stats = host.sceneStats(scene.root);
    expect(stats.nodeCount).toBe(31);
    expect(stats.textCount).toBeGreaterThan(0);
    expect(stats.imageCount).toBeGreaterThan(0);
    expect(stats.maxDepth).toBeGreaterThan(1);
  });

  it("aggregates degradation reasons, most frequent first", () => {
    const scene = JSON.parse(
      readFileSync(join(fixturesDir, "typography", "expected-scene.json"), "utf8"),
    );
    const stats = host.sceneStats(scene.root);
    expect(stats.reasons.length).toBeGreaterThan(0);
    const counts = stats.reasons.map((row) => row.count);
    expect(counts).toEqual([...counts].sort((a, b) => b - a));
    expect(stats.degraded).toBeGreaterThan(0);
  });

  it("survives a deep tree without blowing the stack", () => {
    // Iterative traversal is the point; 5000 levels would end a recursive one.
    const root: Record<string, unknown> = { role: "box", children: [] };
    let cursor = root;
    for (let i = 0; i < 5000; i += 1) {
      const child = { role: "box", children: [] as unknown[] };
      (cursor["children"] as unknown[]).push(child);
      cursor = child;
    }
    const stats = host.sceneStats(root);
    expect(stats.nodeCount).toBe(5001);
    expect(stats.maxDepth).toBe(5001);
  });
});

describe("loadSceneFile", () => {
  it("reads a scene from disk and summarises it", () => {
    loadHost();
    const raw = readFileSync(join(fixturesDir, "stacking", "expected-scene.json"), "utf8");
    files["/scenes/page.web2ai.json"] = raw;

    const summary = host.loadSceneFile("/scenes/page.web2ai.json");
    expect(summary.path).toBe("/scenes/page.web2ai.json");
    expect(summary.url).toContain("fixture://stacking");
    expect(summary.nodeCount).toBe(17);
    expect(summary.degraded).toBe(0);
  });

  it("refuses a JSON file that is not a scene, and says why", () => {
    loadHost();
    files["/scenes/other.json"] = JSON.stringify({ some: "object" });
    expect(() => host.loadSceneFile("/scenes/other.json")).toThrow(/Not a usable ui-scene file/);
  });

  it("reports a missing file rather than failing obscurely", () => {
    loadHost();
    expect(() => host.loadSceneFile("/scenes/absent.json")).toThrow(/File not found/);
  });
});
