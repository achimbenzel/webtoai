import type { AssetRequest, CaptureOptions, Scene } from "@web2ai/schema";
import type { AssetResolution } from "../lib/assets.ts";
import type { LogSummaryRow } from "../lib/log.ts";

/**
 * The message protocol between popup, service worker and content script.
 *
 * Three hops, each with one job:
 *   popup   --capture-->        background   (user intent + options)
 *   background --run-capture--> content      (walk the DOM, no I/O)
 *   background                               (fetch assets, assemble, validate)
 */

export const MSG = {
  CAPTURE: "web2ai:capture",
  RUN_CAPTURE: "web2ai:run-capture",
  PING: "web2ai:ping",
} as const;

export interface CaptureMessage {
  type: typeof MSG.CAPTURE;
  options: CaptureOptions;
}

export interface RunCaptureMessage {
  type: typeof MSG.RUN_CAPTURE;
  options: CaptureOptions;
}

export interface PingMessage {
  type: typeof MSG.PING;
}

export type ExtensionMessage = CaptureMessage | RunCaptureMessage | PingMessage;

/** What the content script hands back: a scene with no assets resolved yet. */
export type WalkResponse =
  | {
      ok: true;
      scene: Scene;
      assetRequests: AssetRequest[];
      log: LogSummaryRow[];
    }
  | { ok: false; error: string };

export interface CaptureStats {
  nodeCount: number;
  maxDepth: number;
  unsupportedCount: number;
  textCount: number;
  imageCount: number;
  assetCount: number;
  assetsFailed: number;
  bytes: number;
  durationMs: number;
}

/** What the popup receives: the finished scene plus everything it displays. */
export type CaptureResponse =
  | {
      ok: true;
      scene: Scene;
      stats: CaptureStats;
      log: LogSummaryRow[];
      suggestedFilename: string;
    }
  | { ok: false; error: string };

export type { AssetResolution };
