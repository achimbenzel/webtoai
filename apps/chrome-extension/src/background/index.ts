import { config, sceneStats, validateScene } from "@web2ai/schema";
import type { AssetRequest } from "@web2ai/schema";
import { buildAssets, type AssetResolution } from "../lib/assets.ts";
import {
  MSG,
  type CaptureMessage,
  type CaptureResponse,
  type CaptureStats,
  type WalkResponse,
} from "../shared/messages.ts";

/**
 * MV3 service worker.
 *
 * Two jobs the page cannot do itself:
 *  - inject and drive the content script;
 *  - fetch images. Extension `fetch` is not bound by the page's CORS rules, so
 *    an image the page could never read into a canvas is still embeddable here.
 */

chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  if (!isCaptureMessage(message)) return false;

  capture(message)
    .then(sendResponse)
    .catch((error: unknown) => {
      sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      } satisfies CaptureResponse);
    });

  return true;
});

function isCaptureMessage(message: unknown): message is CaptureMessage {
  return (
    typeof message === "object" &&
    message !== null &&
    (message as { type?: unknown }).type === MSG.CAPTURE
  );
}

async function activeTab(): Promise<chrome.tabs.Tab> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab === undefined || tab.id === undefined) {
    throw new Error("No active tab to capture.");
  }
  const url = tab.url ?? "";
  if (/^(chrome|edge|about|devtools|chrome-extension):/i.test(url)) {
    throw new Error(
      "Browser-internal pages cannot be captured. Open a normal http(s) page and try again.",
    );
  }
  return tab;
}

async function capture(message: CaptureMessage): Promise<CaptureResponse> {
  const startedAt = Date.now();
  const tab = await activeTab();
  const tabId = tab.id;
  if (tabId === undefined) throw new Error("No active tab to capture.");

  await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });

  const walkResponse = (await chrome.tabs.sendMessage(tabId, {
    type: MSG.RUN_CAPTURE,
    options: message.options,
  })) as WalkResponse | undefined;

  if (walkResponse === undefined)
    throw new Error("The page did not respond to the capture request.");
  if (!walkResponse.ok) return { ok: false, error: walkResponse.error };

  const { scene, assetRequests, log } = walkResponse;

  const resolutions = message.options.embedImages
    ? await resolveAssets(assetRequests)
    : ([] as AssetResolution[]);

  scene.assets = buildAssets(assetRequests, resolutions, message.options.embedImages);

  // Validate again after the assets went in: this is the payload that will be
  // handed to Illustrator, so it is the one that has to be correct.
  const validation = validateScene(scene);
  if (!validation.ok) return { ok: false, error: validation.message };

  const serialised = JSON.stringify(validation.value);
  const structural = sceneStats(validation.value);
  const stats: CaptureStats = {
    ...structural,
    assetCount: scene.assets.length,
    assetsFailed: scene.assets.filter((asset) => asset.error !== undefined).length,
    bytes: serialised.length,
    durationMs: Date.now() - startedAt,
  };

  return {
    ok: true,
    scene: validation.value,
    stats,
    log,
    suggestedFilename: suggestFilename(validation.value.source.url),
  };
}

function suggestFilename(url: string): string {
  let host = "page";
  try {
    host = new URL(url).hostname.replace(/^www\./, "") || "page";
  } catch {
    // Keep the default.
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  return `${host}-${stamp}.web2ai.json`;
}

async function resolveAssets(requests: readonly AssetRequest[]): Promise<AssetResolution[]> {
  const fetchable = requests.filter((request) => request.url !== undefined);
  return Promise.all(fetchable.map((request) => resolveOne(request)));
}

async function resolveOne(request: AssetRequest): Promise<AssetResolution> {
  const url = request.url;
  if (url === undefined) return { id: request.id, ok: false, error: "asset-no-url" };

  try {
    const response = await fetch(url, {
      credentials: "include",
      signal: AbortSignal.timeout(config.capture.assetTimeoutMs),
    });
    if (!response.ok) {
      return { id: request.id, ok: false, error: `asset-http-${response.status}` };
    }

    const blob = await response.blob();
    if (blob.size > config.capture.maxAssetBytes) {
      return { id: request.id, ok: false, error: "asset-too-large" };
    }

    return {
      id: request.id,
      ok: true,
      mime: blob.type !== "" ? blob.type : "application/octet-stream",
      dataUrl: await blobToDataUrl(blob),
    };
  } catch (error) {
    const detail = error instanceof Error ? error.name : "unknown";
    return { id: request.id, ok: false, error: `asset-fetch-failed:${detail}` };
  }
}

/**
 * Base64-encodes a blob.
 *
 * `FileReader` and `URL.createObjectURL` do not exist in a service worker, so
 * the bytes are walked by hand. The chunking keeps `String.fromCharCode` from
 * blowing the argument limit on large images.
 */
async function blobToDataUrl(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const CHUNK = 0x8000;
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + CHUNK));
  }
  const mime = blob.type !== "" ? blob.type : "application/octet-stream";
  return `data:${mime};base64,${btoa(binary)}`;
}
