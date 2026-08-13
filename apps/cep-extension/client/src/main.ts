import {
  SystemPath,
  callHost,
  cepApiVersion,
  ensureHostLoaded,
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

/** Cached so the panel does not re-probe the engine on every button press. */
let hostReady = false;

/**
 * Guarantees the host is loaded, and turns a failure into something readable.
 *
 * Relying on the manifest's ScriptPath alone means any failure surfaces as
 * "web2ai is undefined" at the first call, with nothing about the cause.
 */
async function prepareHost(root: string): Promise<void> {
  if (hostReady) return;

  const result = await ensureHostLoaded(`${root}/jsx/host.jsx`);
  switch (result.state) {
    case "already-loaded":
    case "loaded":
      hostReady = true;
      return;
    case "missing":
      throw new Error(
        `The host script is missing at ${result.path}. Rebuild and reinstall: ` +
          `pnpm --filter @web2ai/cep-extension build && pnpm dev:install`,
      );
    case "error":
      throw new Error(`The host script failed to load (line ${result.line}): ${result.message}`);
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
    const root = extensionRoot();
    await prepareHost(root);
    const hello = await callHost<HostHello>("hello", [root]);
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
    await prepareHost(extensionRoot());
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
    setLead(status, "Loaded and validated.", "ok");
    el<HTMLButtonElement>("import-scene").disabled = false;
    setLead(el("import-status"), "Ready to build the document.", "none");
  } catch (error) {
    setLead(status, error instanceof Error ? error.message : String(error), "err");
    info.replaceChildren();
    renderSceneReport([]);
  } finally {
    button.disabled = false;
  }
}

interface RenderBegin {
  total: number;
  documentName: string;
  width: number;
  height: number;
  assetCount: number;
}

interface RenderStep {
  done: boolean;
  built: number;
  failed: number;
  total: number;
}

interface ReportRow {
  level: "info" | "warn" | "unsupported";
  code: string;
  count: number;
  detail: string;
  examples: string[];
}

interface ReportSummary {
  rows: ReportRow[];
  fontSubstitutions: Array<{ requested: string; used: string; reason: string; count: number }>;
  nodesTotal: number;
  nodesBuilt: number;
  nodesFailed: number;
  unsupported: number;
  warnings: number;
  cancelled: boolean;
  durationMs: number;
}

/** Set by the Cancel button; the render loop checks it between batches. */
let cancelRequested = false;

function setProgress(fraction: number, visible: boolean): void {
  el("progress").hidden = !visible;
  el("progress-bar").style.width = `${Math.round(Math.min(Math.max(fraction, 0), 1) * 100)}%`;
}

function renderImportReport(summary: ReportSummary): void {
  const wrapper = el("import-report");
  const body = el<HTMLTableSectionElement>("import-report-rows");
  body.replaceChildren();

  const rows: Array<[string, string]> = summary.rows.map((row) => [
    `${row.code}${row.examples.length > 0 ? ` (${row.examples[0]}…)` : ""}`,
    String(row.count),
  ]);
  for (const substitution of summary.fontSubstitutions) {
    rows.push([
      `font: ${substitution.requested} -> ${substitution.used}`,
      String(substitution.count),
    ]);
  }

  if (rows.length === 0) {
    wrapper.hidden = true;
    return;
  }

  el("import-report-summary").textContent =
    `Report -- ${summary.unsupported} unsupported, ${summary.warnings} approximated`;

  for (const [label, count] of rows) {
    const tr = document.createElement("tr");
    const first = document.createElement("td");
    first.textContent = label;
    const second = document.createElement("td");
    second.textContent = count;
    tr.append(first, second);
    body.append(tr);
  }
  wrapper.hidden = false;
}

/**
 * Runs the import.
 *
 * The loop lives here rather than in ExtendScript because ExtendScript blocks
 * Illustrator outright: a single call would freeze the application with no
 * progress and no way to stop. Driving it batch by batch is what makes both
 * possible.
 */
async function importScene(): Promise<void> {
  const status = el("import-status");
  const info = el("import-info");
  const importButton = el<HTMLButtonElement>("import-scene");
  const cancelButton = el<HTMLButtonElement>("cancel-import");
  const exportButton = el<HTMLButtonElement>("export-report");

  cancelRequested = false;
  importButton.disabled = true;
  cancelButton.hidden = false;
  exportButton.hidden = true;
  info.replaceChildren();
  el("import-report").hidden = true;

  try {
    await prepareHost(extensionRoot());

    const begin = await callHost<RenderBegin>("startRender");
    setLead(status, `Building ${begin.documentName}...`, "none");
    setProgress(0, true);

    let step: RenderStep = { done: false, built: 0, failed: 0, total: begin.total };
    while (!step.done && !cancelRequested) {
      step = await callHost<RenderStep>("stepRender", [PROGRESS_BATCH]);
      setProgress(step.total > 0 ? step.built / step.total : 1, true);
      setLead(status, `Building... ${step.built} of ${step.total} nodes`, "none");
      // Yield to the panel so the Cancel button can actually be clicked.
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    const summary = await callHost<ReportSummary>("finishRender", [cancelRequested]);
    setProgress(1, false);

    renderKeyValues(info, [
      ["Document", begin.documentName],
      ["Artboard", `${Math.round(begin.width)} x ${Math.round(begin.height)} pt`],
      ["Nodes", `${summary.nodesBuilt} of ${summary.nodesTotal}`],
      ["Failed", String(summary.nodesFailed)],
      ["Unsupported", String(summary.unsupported)],
      ["Approximated", String(summary.warnings)],
      ["Time", `${(summary.durationMs / 1000).toFixed(1)} s`],
    ]);
    renderImportReport(summary);
    exportButton.hidden = false;

    if (summary.cancelled) {
      setLead(status, "Cancelled. The partial document is left open.", "warn");
    } else if (summary.nodesFailed > 0) {
      setLead(
        status,
        `Done, with ${summary.nodesFailed} node(s) that failed. See the report.`,
        "warn",
      );
    } else if (summary.unsupported > 0) {
      setLead(status, "Done. Some features were degraded -- see the report.", "warn");
    } else {
      setLead(status, "Done. Nothing was degraded.", "ok");
    }
  } catch (error) {
    setProgress(0, false);
    setLead(status, error instanceof Error ? error.message : String(error), "err");
  } finally {
    importButton.disabled = false;
    cancelButton.hidden = true;
  }
}

/** Nodes per batch. Small enough to stay responsive, large enough to be quick. */
const PROGRESS_BATCH = 40;

async function exportReport(): Promise<void> {
  const status = el("import-status");
  try {
    const result = await callHost<{ cancelled: boolean; path: string }>("exportReport");
    if (result.cancelled) return;
    setLead(status, `Report written to ${result.path}`, "ok");
  } catch (error) {
    setLead(status, error instanceof Error ? error.message : String(error), "err");
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
  el<HTMLButtonElement>("import-scene").addEventListener("click", () => {
    void importScene();
  });
  el<HTMLButtonElement>("cancel-import").addEventListener("click", () => {
    cancelRequested = true;
    setLead(el("import-status"), "Cancelling after the current batch...", "warn");
  });
  el<HTMLButtonElement>("export-report").addEventListener("click", () => {
    void exportReport();
  });

  void refreshHost();
}

main();
