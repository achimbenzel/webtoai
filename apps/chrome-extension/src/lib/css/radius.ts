import type { Quad } from "@web2ai/schema";
import { parseLengthOrPercentage, round, splitTopLevelWhitespace } from "./values.ts";

/** The four computed `border-*-radius` values, in CSS corner order. */
export interface CornerRadiusInput {
  topLeft: string;
  topRight: string;
  bottomRight: string;
  bottomLeft: string;
}

export interface RadiusResult {
  radius: Quad;
  reasons: string[];
}

interface Corner {
  x: number;
  y: number;
}

/**
 * A single computed corner value is either one length (`8px`) or two for an
 * elliptical corner (`8px 4px`).
 *
 * Each radius resolves against its own axis — width for horizontal, height for
 * vertical — including in the single-value form. `border-radius: 50%` on a
 * 200x100 box is therefore a 100x50 ellipse, not a 100x100 circle.
 */
function parseCorner(value: string, box: { w: number; h: number }): Corner | null {
  const tokens = splitTopLevelWhitespace(value.trim());
  const horizontal = tokens[0];
  if (horizontal === undefined) return null;

  const x = parseLengthOrPercentage(horizontal, box.w);
  if (x === null) return null;

  const vertical = tokens[1] ?? horizontal;
  const y = parseLengthOrPercentage(vertical, box.h);
  return { x: Math.max(x, 0), y: Math.max(y ?? x, 0) };
}

/**
 * Resolves the four corner radii of a box.
 *
 * Two CSS behaviours are reproduced here because ignoring them produces
 * visibly wrong shapes:
 *
 *  - **Overlap scaling.** When the radii on one side add up to more than that
 *    side's length, *all* radii are scaled down by the same factor. This is
 *    what makes `border-radius: 9999px` render as a pill rather than garbage.
 *  - **Elliptical corners.** Illustrator's rounded rectangles take a single
 *    radius per corner, so an elliptical corner is reduced to its horizontal
 *    radius and reported.
 */
export function parseBorderRadius(
  input: CornerRadiusInput,
  box: { w: number; h: number },
): RadiusResult {
  const reasons: string[] = [];
  const corners: Corner[] = [];

  for (const value of [input.topLeft, input.topRight, input.bottomRight, input.bottomLeft]) {
    const corner = parseCorner(value, box);
    if (corner === null) {
      if (value.trim() !== "" && value.trim() !== "0px") reasons.push("radius-unparsable");
      corners.push({ x: 0, y: 0 });
      continue;
    }
    corners.push(corner);
  }

  const [tl, tr, br, bl] = corners as [Corner, Corner, Corner, Corner];

  // CSS 3 Backgrounds §5.5: find the smallest scale factor over all four sides.
  const ratios = [
    box.w > 0 ? box.w / (tl.x + tr.x) : Infinity,
    box.h > 0 ? box.h / (tr.y + br.y) : Infinity,
    box.w > 0 ? box.w / (br.x + bl.x) : Infinity,
    box.h > 0 ? box.h / (bl.y + tl.y) : Infinity,
  ].filter((ratio) => Number.isFinite(ratio) && ratio > 0);

  const scale = Math.min(1, ...ratios);
  if (scale < 1) reasons.push("radius-scaled-to-fit");

  if (corners.some((corner) => Math.abs(corner.x - corner.y) > 0.01)) {
    reasons.push("radius-elliptical-approximated");
  }

  return {
    radius: [
      round(tl.x * scale),
      round(tr.x * scale),
      round(br.x * scale),
      round(bl.x * scale),
    ] as Quad,
    reasons,
  };
}

/** True when every corner is 0 — lets the renderer take the plain-rect path. */
export function isSquare(radius: Quad): boolean {
  return radius.every((value) => value === 0);
}

/** True when all four corners are equal — `roundedRectangle` can be used directly. */
export function isUniform(radius: Quad): boolean {
  return radius[0] === radius[1] && radius[1] === radius[2] && radius[2] === radius[3];
}
