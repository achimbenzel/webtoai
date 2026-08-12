import { defaultCaptureOptions } from "@web2ai/schema";
import type { CaptureOptions, Scene } from "@web2ai/schema";
import { MSG, type CaptureResponse, type CaptureStats } from "../shared/messages.ts";
import type { LogSummaryRow } from "../lib/log.ts";

/**
 * Popup: capture options, one button, and an honest summary of what happened.
 *
 * The download runs here rather than in the service worker on purpose:
 * `URL.createObjectURL` does not exist in a worker, and passing a multi-megabyte
 * data: URL to `chrome.downloads` is unreliable. The popup is a normal document
 * and is by definition open while the user is capturing.
 */

const STORAGE_KEY = "web2ai:options";

function el<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (found === null) throw new Error(`Missing element #${id}`);
  return found as T;
}

const controls = {
  form: () => el<HTMLFormElement>("options"),
  scopeFull: () => el<HTMLInputElement>("scope-full"),
  scopeViewport: () => el<HTMLInputElement>("scope-viewport"),
  rootSelector: () => el<HTMLInputElement>("root-selector"),
  maxDepth: () => el<HTMLInputElement>("max-depth"),
  embedImages: () => el<HTMLInputElement>("embed-images"),
  textAsOutlines: () => el<HTMLInputElement>("text-as-outlines"),
  pseudoElements: () => el<HTMLInputElement>("pseudo-elements"),
  captureCanvas: () => el<HTMLInputElement>("capture-canvas"),
  capture: () => el<HTMLButtonElement>("capture"),
  status: () => el<HTMLOutputElement>("status"),
  results: () => el<HTMLElement>("results"),
  stats: () => el<HTMLDListElement>("stats"),
  reportRows: () => el<HTMLTableSectionElement>("report-rows"),
  reportSummary: () => el<HTMLElement>("report-summary"),
  version: () => el<HTMLElement>("version"),
};

function readOptions(): CaptureOptions {
  const defaults = defaultCaptureOptions();
  const depth = Number.parseInt(controls.maxDepth().value, 10);
  return {
    ...defaults,
    fullPage: controls.scopeFull().checked,
    rootSelector: controls.rootSelector().value.trim(),
    maxDepth: Number.isFinite(depth) && depth > 0 ? depth : defaults.maxDepth,
    embedImages: controls.embedImages().checked,
    textAsOutlines: controls.textAsOutlines().checked,
    capturePseudoElements: controls.pseudoElements().checked,
    captureCanvas: controls.captureCanvas().checked,
  };
}

function writeOptions(options: CaptureOptions): void {
  controls.scopeFull().checked = options.fullPage;
  controls.scopeViewport().checked = !options.fullPage;
  controls.rootSelector().value = options.rootSelector;
  controls.maxDepth().value = String(options.maxDepth);
  controls.embedImages().checked = options.embedImages;
  controls.textAsOutlines().checked = options.textAsOutlines;
  controls.pseudoElements().checked = options.capturePseudoElements;
  controls.captureCanvas().checked = options.captureCanvas;
}

async function loadOptions(): Promise<CaptureOptions> {
  const defaults = defaultCaptureOptions();
  try {
    const stored = await chrome.storage.local.get(STORAGE_KEY);
    const saved = stored[STORAGE_KEY] as Partial<CaptureOptions> | undefined;
    return saved === undefined ? defaults : { ...defaults, ...saved };
  } catch {
    return defaults;
  }
}

async function saveOptions(options: CaptureOptions): Promise<void> {
  try {
    await chrome.storage.local.set({ [STORAGE_KEY]: options });
  } catch {
    // Persisting preferences is a convenience, never a reason to fail a capture.
  }
}

function setStatus(text: string, tone: "ok" | "warn" | "err" | "none"): void {
  const status = controls.status();
  status.textContent = text;
  status.className = tone === "none" ? "status" : `status status--${tone}`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} kB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function renderStats(stats: CaptureStats): void {
  const rows: Array<[string, string]> = [
    ["Nodes", String(stats.nodeCount)],
    ["Depth", String(stats.maxDepth)],
    ["Text", String(stats.textCount)],
    ["Images", String(stats.imageCount)],
    [
      "Assets",
      stats.assetsFailed > 0
        ? `${stats.assetCount} (${stats.assetsFailed} failed)`
        : String(stats.assetCount),
    ],
    ["Degraded", String(stats.unsupportedCount)],
    ["Size", formatBytes(stats.bytes)],
    ["Time", `${stats.durationMs} ms`],
  ];

  const target = controls.stats();
  target.replaceChildren();
  for (const [key, value] of rows) {
    const dt = document.createElement("dt");
    dt.textContent = key;
    const dd = document.createElement("dd");
    dd.textContent = value;
    target.append(dt, dd);
  }
}

function renderReport(log: readonly LogSummaryRow[]): void {
  const body = controls.reportRows();
  body.replaceChildren();

  const notable = log.filter((row) => row.level !== "info");
  controls.reportSummary().textContent =
    notable.length === 0
      ? `Report — nothing degraded (${log.length} informational)`
      : `Report — ${notable.length} kind(s) of degradation`;

  for (const row of log) {
    const tr = document.createElement("tr");

    const code = document.createElement("td");
    code.textContent = row.code;
    code.className = `report__level--${row.level}`;

    const count = document.createElement("td");
    count.textContent = String(row.count);

    tr.append(code, count);
    if (row.examples.length > 0) tr.title = row.examples.join(", ");
    body.append(tr);
  }
}

async function download(scene: Scene, filename: string): Promise<void> {
  const blob = new Blob([JSON.stringify(scene, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  try {
    await chrome.downloads.download({ url, filename, saveAs: false });
  } finally {
    // The download reads the blob asynchronously; revoking immediately would
    // cancel it.
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
}

async function runCapture(event: SubmitEvent): Promise<void> {
  event.preventDefault();

  const button = controls.capture();
  const options = readOptions();
  void saveOptions(options);

  button.disabled = true;
  controls.results().hidden = true;
  setStatus("Capturing…", "none");

  try {
    const response = (await chrome.runtime.sendMessage({
      type: MSG.CAPTURE,
      options,
    })) as CaptureResponse | undefined;

    if (response === undefined) throw new Error("The extension service worker did not respond.");
    if (!response.ok) {
      setStatus(response.error, "err");
      return;
    }

    renderStats(response.stats);
    renderReport(response.log);
    controls.results().hidden = false;

    await download(response.scene, response.suggestedFilename);

    const degraded = response.stats.unsupportedCount;
    setStatus(
      degraded === 0
        ? `Saved ${response.suggestedFilename}`
        : `Saved ${response.suggestedFilename} — ${degraded} node(s) degraded, see report`,
      degraded === 0 ? "ok" : "warn",
    );
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error), "err");
  } finally {
    button.disabled = false;
  }
}

async function main(): Promise<void> {
  controls.version().textContent = `v${__WEB2AI_VERSION__}`;
  writeOptions(await loadOptions());
  controls.form().addEventListener("submit", (event) => {
    void runCapture(event);
  });
}

void main();
