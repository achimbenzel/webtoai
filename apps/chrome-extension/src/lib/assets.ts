import type { Asset, AssetKind, AssetRequest } from "@web2ai/schema";
import { parseFunction, splitTopLevel, stripQuotes } from "./css/values.ts";
import { hash32 } from "./naming.ts";

/**
 * Collects the images a scene needs while the walk is running.
 *
 * The walker stays synchronous — it only records *requests*. Fetching is a
 * separate, asynchronous pass that runs in the service worker, which is not
 * bound by the page's CORS rules. Keeping the two apart is what lets the
 * walker be tested without a network.
 */
export class AssetCollector {
  private readonly byKey = new Map<string, AssetRequest>();

  /** Registers an external image; returns the stable asset id. */
  addUrl(url: string, kind: AssetKind, width: number, height: number): string {
    const key = `url:${url}`;
    const existing = this.byKey.get(key);
    if (existing !== undefined) {
      // A later use may know the intrinsic size when the first one did not.
      if (existing.width === 0 && width > 0) existing.width = width;
      if (existing.height === 0 && height > 0) existing.height = height;
      return existing.id;
    }
    const id = `a${hash32(key)}`;
    this.byKey.set(key, { id, kind, url, width, height });
    return id;
  }

  /** Registers content we already hold: inline SVG source or a canvas data URL. */
  addInline(mime: string, data: string, kind: AssetKind, width: number, height: number): string {
    const key = `inline:${mime}:${hash32(data)}`;
    const existing = this.byKey.get(key);
    if (existing !== undefined) return existing.id;
    const id = `a${hash32(key)}`;
    this.byKey.set(key, { id, kind, inline: { mime, data }, width, height });
    return id;
  }

  requests(): AssetRequest[] {
    return [...this.byKey.values()];
  }
}

/**
 * Extracts the first `url()` from a `background-image` value.
 *
 * `background-image` is a comma-separated *list* of layers painted front to
 * back. Only the first is representable as a single fill; the caller reports
 * the rest.
 */
export function backgroundImageUrls(value: string): string[] {
  const trimmed = value.trim();
  if (trimmed === "" || trimmed.toLowerCase() === "none") return [];

  const urls: string[] = [];
  for (const layer of splitTopLevel(trimmed, ",")) {
    const fn = parseFunction(layer);
    if (fn === null || fn.name !== "url") continue;
    const url = stripQuotes(fn.args);
    if (url.length > 0) urls.push(url);
  }
  return urls;
}

/** Number of layers in a `background-image` value, gradients included. */
export function backgroundLayerCount(value: string): number {
  const trimmed = value.trim();
  if (trimmed === "" || trimmed.toLowerCase() === "none") return 0;
  return splitTopLevel(trimmed, ",").length;
}

/** MIME type guessed from a URL's extension; the fetch result wins over this. */
export function guessMimeFromUrl(url: string): string {
  const withoutQuery = url.split(/[?#]/)[0] ?? "";
  const extension = (withoutQuery.split(".").pop() ?? "").toLowerCase();
  switch (extension) {
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    case "avif":
      return "image/avif";
    case "svg":
      return "image/svg+xml";
    case "bmp":
      return "image/bmp";
    case "ico":
      return "image/x-icon";
    default:
      return "application/octet-stream";
  }
}

export function kindForMime(mime: string): AssetKind {
  return mime === "image/svg+xml" ? "svg" : "raster";
}

/** Resolution outcome for one request, produced by the service worker. */
export type AssetResolution =
  | { id: string; ok: true; mime: string; dataUrl: string }
  | { id: string; ok: false; error: string };

/**
 * Turns requests plus their resolutions into the scene's `assets` array.
 *
 * A failed asset is *kept*, with `error` set — the node still exists in the
 * document, and the import report needs to be able to say what went missing.
 */
export function buildAssets(
  requests: readonly AssetRequest[],
  resolutions: readonly AssetResolution[],
  embedImages: boolean,
): Asset[] {
  const byId = new Map(resolutions.map((resolution) => [resolution.id, resolution]));

  return requests.map((request): Asset => {
    if (request.inline !== undefined) {
      const asset: Asset = {
        id: request.id,
        kind: request.kind,
        mime: request.inline.mime,
        width: request.width,
        height: request.height,
      };
      if (request.kind === "svg") return { ...asset, svg: request.inline.data };
      return { ...asset, dataUrl: request.inline.data };
    }

    // `<img src="logo.svg">` is requested as a raster — the walker only sees an
    // `<img>`. The URL is the first evidence of what it really is, and the
    // renderer imports SVG through a different API entirely, so the kind is
    // corrected here rather than left for the host to sniff.
    const mime = guessMimeFromUrl(request.url ?? "");
    const base: Asset = {
      id: request.id,
      kind: kindForMime(mime),
      mime,
      width: request.width,
      height: request.height,
    };
    if (request.url !== undefined) base.src = request.url;

    if (!embedImages) return base;

    const resolution = byId.get(request.id);
    if (resolution === undefined) {
      return { ...base, error: "asset-not-resolved" };
    }
    if (!resolution.ok) {
      return { ...base, error: resolution.error };
    }
    return {
      ...base,
      mime: resolution.mime,
      kind: kindForMime(resolution.mime),
      dataUrl: resolution.dataUrl,
    };
  });
}
