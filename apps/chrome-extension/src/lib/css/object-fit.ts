/**
 * `object-fit` and `object-position`.
 *
 * These two decide how a replaced element's intrinsic image is fitted into the
 * box CSS laid out for it. Ignoring them is not a cosmetic loss: the default in
 * a lot of real-world CSS is `cover`, which crops, and rendering that as `fill`
 * stretches the image by whatever the aspect ratio difference happens to be.
 *
 * The scene carries the resolved values rather than the fitted rectangle, so
 * the renderer can compute the fit against the *placed* image's real intrinsic
 * size — which is not always the size the DOM reported.
 */

import type { ObjectFit } from "@web2ai/schema";
import { clamp, parseLength, parsePercentage, round, splitTopLevelWhitespace } from "./values.js";

const FITS: readonly string[] = ["fill", "contain", "cover", "none", "scale-down"];

/** Returns null for anything that is not one of the five keywords. */
export function parseObjectFit(input: string): ObjectFit | null {
  const value = input.trim().toLowerCase();
  return FITS.indexOf(value) === -1 ? null : (value as ObjectFit);
}

/** Keyword forms; percentages and lengths are handled by the caller. */
const KEYWORDS_X: Record<string, string> = { left: "0%", center: "50%", right: "100%" };
const KEYWORDS_Y: Record<string, string> = { top: "0%", center: "50%", bottom: "100%" };

/**
 * Resolves `object-position` to a fraction of the leftover space on each axis,
 * the same normalisation CSS itself uses: with a box `w` wide and an image `iw`
 * wide, the image's left edge sits at `x * (w - iw)`.
 *
 * That normalisation is what makes the value independent of the image's
 * intrinsic size, which the capture side does not always know. It is exact for
 * the percentage form (which is how `getComputedStyle` reports keywords) and an
 * approximation for absolute lengths, which cannot be expressed as a fraction
 * without knowing both sizes — those are resolved against the box and reported.
 *
 * @param box Border-box size in CSS px, used to resolve absolute lengths.
 */
export function parseObjectPosition(
  input: string,
  box: { w: number; h: number },
): { position: { x: number; y: number }; reasons: string[] } {
  const reasons: string[] = [];
  const centre = { position: { x: 0.5, y: 0.5 }, reasons };

  const tokens = splitTopLevelWhitespace(input.trim().toLowerCase());
  if (tokens.length === 0) return centre;
  // Three- and four-value forms ("right 10px bottom 20px") are edge-relative
  // offsets that need the image size to normalise. getComputedStyle does not
  // produce them, but a scene could arrive from elsewhere.
  if (tokens.length > 2) {
    reasons.push("object-position-approximated");
    return centre;
  }

  const rawX = tokens[0] ?? "center";
  const rawY = tokens[1] ?? "center";
  // A single "top" or "bottom" names the *vertical* axis and centres the other.
  const swap = tokens.length === 1 && (rawX === "top" || rawX === "bottom");

  const x = axis(swap ? "center" : rawX, KEYWORDS_X, box.w, reasons);
  const y = axis(swap ? rawX : rawY, KEYWORDS_Y, box.h, reasons);
  if (x === null || y === null) {
    reasons.push("object-position-approximated");
    return centre;
  }
  return { position: { x, y }, reasons };
}

function axis(
  token: string,
  keywords: Record<string, string>,
  extent: number,
  reasons: string[],
): number | null {
  const resolved = keywords[token] ?? token;
  const fraction = parsePercentage(resolved);
  if (fraction !== null) return round(clamp(fraction, 0, 1), 4);

  const length = parseLength(resolved);
  if (length === null) return null;
  // An absolute offset is a distance from the box edge to the image edge, not a
  // fraction of the leftover space; the two only agree when the image fills the
  // box. Expressing it against the box is the closest we can get without the
  // intrinsic size, and it is reported rather than passed off as exact.
  if (length !== 0) reasons.push("object-position-approximated");
  if (extent <= 0) return 0;
  return round(clamp(length / extent, 0, 1), 4);
}
