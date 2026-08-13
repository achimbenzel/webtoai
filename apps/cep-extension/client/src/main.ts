import {
  SystemPath,
  callHost,
  cepApiVersion,
  hostEnvironment,
  isCepAvailable,
  systemPath,
} from "./cep/bridge.ts";

/** Shape returned by `web2ai.hello()` in host/90-entrypoints.jsx. */
interface HostHello {
  host: string;
  version: string;
  schemaVersion: number;
  app: string;
  appVersion: string;
  locale: string;
  engine: string;
  extensionRoot: string;
  jsonAvailable: boolean;
  configLoaded: boolean;
  configError: string;
  renderMaxLayerDepth: number;
  sceneLoaded: boolean;
  scenePath: string;
}

/** Shape returned by `web2ai.openScene()` / `web2ai.loadScene()`. */
interface SceneSummary {
  cancelled: boolean;
  path?: string;
  url?: string;
  title?: string;
  capturedAt?: string;
  documentWidth?: number;
  documentHeight?: number;
  assetCount?: number;
  fontCount?: number;
  nodeCount?: number;
  maxDepth?: number;
  textCount?: number;
  imageCount?: number;
  degraded?: number;
  reasons?: Array<{ code: string; count: number }>;
}

function el<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (found === null) throw new Error(`Missing element #${id}`);
  return found as T;
}

function setLead(node: HTMLElement, text: string, tone: "ok" | "warn" | "err" | "none"): void {
  node.textContent = text;
  node.classList.remove("card__lead--ok", "card__lead--warn", "card__lead--err");
  if (tone !== "none") node.classList.add(`card__lead--${tone}`);
}

function renderKeyValues(target: HTMLElement, entries: ReadonlyArray<[string, string]>): void {
  target.replaceChildren();
  for (const [key, value] of entries) {
    const dt = document.createElement("dt");
    dt.textContent = key;
    const dd = document.createElement("dd");
    dd.textContent = value;
    target.append(dt, dd);
  }
}

/**
 * The host cannot work out where it is installed.
 *
 * A script loaded through the manifest's ScriptPath sees the host application
 * in `$.fileName`, not itself, so any path derived from it points into
 * Illustrator's own program folder. CEP's getSystemPath is the only reliable
 * source, and it is only available here.
 */
function extensionRoot(): string {
  try {
    return systemPath(SystemPath.EXTENSION);
  } catch {
    return "";
  }
}

async function refreshHost(): Promise<void> {
  const greeting = el("host-greeting");
  const info = el("host-info");

  if (!isCepAvailable()) {
    setLead(
      greeting,
      "Running outside Illustrator -- CEP APIs unavailable. Open the panel via Window > Extensions > web2ai.",
      "warn",
    );
    renderKeyValues(info, [["CEP", "not detected"]]);
    return;
  }

  const env = hostEnvironment();
  try {
    const hello = await callHost<HostHello>("hello", [extensionRoot()]);
    setLead(greeting, `Hello from ${hello.app} ${hello.appVersion}.`, "ok");
    renderKeyValues(info, [
      ["Host bundle", `v${hello.version} (ui-scene@${hello.schemaVersion})`],
      ["CEP API", cepApiVersion()],
      ["ExtendScript", `${hello.engine} / ${hello.locale}`],
      ["json2.js", hello.jsonAvailable ? "loaded" : "MISSING"],
      [
        "Config",
        hello.configLoaded
          ? `loaded (maxLayerDepth ${hello.renderMaxLayerDepth})`
          : `failed: ${hello.configError}`,
      ],
      ["Extension root", hello.extensionRoot],
    ]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setLead(greeting, message, "err");
    renderKeyValues(info, [
      ["App", env === undefined ? "unknown" : `${env.appName} ${env.appVersion}`],
      ["CEP API", cepApiVersion()],
    ]);
  }
}

function renderSceneReport(reasons: ReadonlyArray<{ code: string; count: number }>): void {
  const wrapper = el("scene-report");
  const body = el<HTMLTableSectionElement>("scene-report-rows");
  body.replaceChildren();

  if (reasons.length === 0) {
    wrapper.hidden = true;
    return;
  }

  el("scene-report-summary").textContent = `Report -- ${reasons.length} kind(s) of degradation`;
  for (const row of reasons) {
    const tr = document.createElement("tr");
    const code = document.createElement("td");
    code.textContent = row.code;
    const count = document.createElement("td");
    count.textContent = String(row.count);
    tr.append(code, count);
    body.append(tr);
  }
  wrapper.hidden = false;
}

function fileNameOf(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] ?? path;
}

async function openScene(): Promise<void> {
  const status = el("scene-status");
  const info = el("scene-info");
  const button = el<HTMLButtonElement>("open-scene");

  button.disabled = true;
  try {
    const summary = await callHost<SceneSummary>("openScene");
    if (summary.cancelled) {
      setLead(status, "No scene loaded.", "none");
      return;
    }

    renderKeyValues(info, [
      ["File", fileNameOf(summary.path ?? "")],
      ["Page", summary.title !== undefined && summary.title !== "" ? summary.title : "(untitled)"],
      ["URL", summary.url ?? ""],
      ["Captured", summary.capturedAt ?? ""],
      ["Document", `${summary.documentWidth ?? 0} x ${summary.documentHeight ?? 0} px`],
      ["Nodes", `${summary.nodeCount ?? 0} (depth ${summary.maxDepth ?? 0})`],
      ["Text / images", `${summary.textCount ?? 0} / ${summary.imageCount ?? 0}`],
      ["Assets / fonts", `${summary.assetCount ?? 0} / ${summary.fontCount ?? 0}`],
      ["Degraded nodes", String(summary.degraded ?? 0)],
    ]);
    renderSceneReport(summary.reasons ?? []);

    // Being straight about what this does and does not do: the scene is in the
    // host's hands and validated, but nothing is drawn until milestone 3.
    setLead(
      status,
      `Loaded and validated. Rendering to an Illustrator document arrives in milestone 3.`,
      "ok",
    );
  } catch (error) {
    setLead(status, error instanceof Error ? error.message : String(error), "err");
    info.replaceChildren();
    renderSceneReport([]);
  } finally {
    button.disabled = false;
  }
}

function main(): void {
  el("panel-version").textContent = `v${__WEB2AI_VERSION__}`;

  el<HTMLButtonElement>("refresh").addEventListener("click", () => {
    void refreshHost();
  });
  el<HTMLButtonElement>("open-scene").addEventListener("click", () => {
    void openScene();
  });

  void refreshHost();
}

main();
