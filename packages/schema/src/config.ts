/**
 * Typed access to the single configuration source at `config/`.
 *
 * Nothing in web2ai may hardcode a port, a layer depth, a font mapping or a
 * skip selector — it all lives in `config/web2ai.config.json` and
 * `config/font-map.json` and is read through this module. The ExtendScript
 * host cannot import TypeScript, so it reads the very same JSON files from
 * disk (see `host/config.jsx`); the shapes below are the contract.
 */
import { z } from "zod";
import rawConfig from "../../../config/web2ai.config.json";
import rawFontMap from "../../../config/font-map.json";
import type { CaptureOptions } from "./types.ts";

const transportSchema = z.object({
  host: z.string(),
  port: z.number().int().min(1).max(65535),
  portFallbackRange: z.number().int().min(0),
  healthTimeoutMs: z.number().int().min(1),
  maxPayloadBytes: z.number().int().min(1),
  allowedOrigins: z.array(z.string()),
});

const captureConfigSchema = z.object({
  fullPage: z.boolean(),
  rootSelector: z.string(),
  textAsOutlines: z.boolean(),
  embedImages: z.boolean(),
  maxDepth: z.number().int().min(1),
  minNodeArea: z.number().min(0),
  skipSelectors: z.array(z.string()),
  capturePseudoElements: z.boolean(),
  captureCanvas: z.boolean(),
  assetTimeoutMs: z.number().int().min(1),
  maxAssetBytes: z.number().int().min(1),
});

const renderConfigSchema = z.object({
  maxLayerDepth: z.number().int().min(1),
  pointsPerCssPixel: z.number().positive(),
  defaultFontFallback: z.string(),
  multiShadowStrategy: z.enum([
    "first-as-effect-rest-unsupported",
    "first-as-effect-rest-duplicated",
  ]),
  embedPlacedImages: z.boolean(),
  progressBatchSize: z.number().int().min(1),
});

const debugConfigSchema = z.object({
  cepRemoteDebugPort: z.number().int().min(1).max(65535),
  logLevel: z.enum(["silent", "error", "warn", "info", "debug"]),
});

export const web2aiConfigSchema = z.object({
  transport: transportSchema,
  capture: captureConfigSchema,
  render: renderConfigSchema,
  debug: debugConfigSchema,
});

export type Web2aiConfig = z.infer<typeof web2aiConfigSchema>;
export type TransportConfig = z.infer<typeof transportSchema>;
export type CaptureConfig = z.infer<typeof captureConfigSchema>;
export type RenderConfig = z.infer<typeof renderConfigSchema>;

const fontMapSchema = z.object({
  families: z.record(z.string(), z.record(z.string(), z.string())),
  genericFamilies: z.record(z.string(), z.string()),
});

export type FontMap = z.infer<typeof fontMapSchema>;

function loadConfig(): Web2aiConfig {
  const parsed = web2aiConfigSchema.safeParse(rawConfig);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`config/web2ai.config.json is invalid: ${detail}`);
  }
  return parsed.data;
}

function loadFontMap(): FontMap {
  const parsed = fontMapSchema.safeParse(rawFontMap);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`config/font-map.json is invalid: ${detail}`);
  }
  return parsed.data;
}

export const config: Web2aiConfig = loadConfig();
export const fontMap: FontMap = loadFontMap();

/** Capture defaults for the popup UI, derived from the config file. */
export function defaultCaptureOptions(): CaptureOptions {
  const c = config.capture;
  return {
    fullPage: c.fullPage,
    rootSelector: c.rootSelector,
    textAsOutlines: c.textAsOutlines,
    embedImages: c.embedImages,
    maxDepth: c.maxDepth,
    minNodeArea: c.minNodeArea,
    skipSelectors: [...c.skipSelectors],
    capturePseudoElements: c.capturePseudoElements,
    captureCanvas: c.captureCanvas,
  };
}

/** `http://127.0.0.1:8787` — built from config, never hardcoded at call sites. */
export function transportBaseUrl(port: number = config.transport.port): string {
  return `http://${config.transport.host}:${port}`;
}

/** Ports the Chrome side probes, in order, when the primary one is taken. */
export function candidatePorts(): number[] {
  const { port, portFallbackRange } = config.transport;
  const ports: number[] = [];
  for (let i = 0; i <= portFallbackRange; i += 1) ports.push(port + i);
  return ports;
}
