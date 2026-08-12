import { defaultCaptureOptions } from "@web2ai/schema";
import type { AssetRequest, CaptureOptions, Scene } from "@web2ai/schema";
import { createCaptureEnv } from "../content/env.ts";
import { buildAssets } from "../lib/assets.ts";
import type { LogSummaryRow } from "../lib/log.ts";
import { dropPrunedNodes, walk } from "../lib/walker.ts";

/**
 * Standalone capture bundle — the walker without any extension plumbing.
 *
 * Two real uses:
 *  - `scripts/capture-fixtures.mjs` drives it through Chromium to regenerate
 *    the committed expected scenes under `fixtures/` against actual layout;
 *  - pasting it into a DevTools console is the fastest way to see what the
 *    walker makes of a page while debugging.
 *
 * It deliberately does not fetch anything, so it is reproducible offline.
 */

export interface StandaloneResult {
  scene: Scene;
  assetRequests: AssetRequest[];
  log: LogSummaryRow[];
}

export type StandaloneOverrides = Partial<CaptureOptions> & { capturedAt?: string };

declare global {
  interface Window {
    __web2aiCapture?: (overrides?: StandaloneOverrides) => StandaloneResult;
  }
}

function captureStandalone(overrides: StandaloneOverrides = {}): StandaloneResult {
  const { capturedAt, ...optionOverrides } = overrides;
  const options: CaptureOptions = { ...defaultCaptureOptions(), ...optionOverrides };

  const env = createCaptureEnv({
    rootSelector: options.rootSelector,
    capturedAt: capturedAt ?? new Date().toISOString(),
  });

  const result = walk(env, options);
  result.scene.root = dropPrunedNodes(result.scene.root);

  // Assemble the asset table with no resolutions: inline SVG and canvas data
  // come through intact, external images keep their URL and metadata but no
  // bytes. That is what makes this bundle reproducible offline.
  result.scene.assets = buildAssets(result.assetRequests, [], false);

  return {
    scene: result.scene,
    assetRequests: result.assetRequests,
    log: result.log.summary(),
  };
}

window.__web2aiCapture = captureStandalone;
