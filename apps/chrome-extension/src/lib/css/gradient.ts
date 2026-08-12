import type { GradientStop, Paint, RGBA } from "@web2ai/schema";
import { parseColorDetailed } from "./color.ts";
import {
  clamp,
  parseAngle,
  parseFunction,
  parseLength,
  parseLengthOrPercentage,
  parsePercentage,
  round,
  splitTopLevel,
  splitTopLevelWhitespace,
} from "./values.ts";

/** The box the gradient paints into; needed to resolve `%` and corner angles. */
export interface GradientBox {
  w: number;
  h: number;
}

export interface GradientResult {
  paint: Paint | null;
  reasons: string[];
}

interface RawStop {
  color: RGBA;
  /** Resolved 0-1 offset, or null when CSS leaves it to be distributed. */
  offset: number | null;
}

const SIDE_ANGLES: Readonly<Record<string, number>> = {
  top: 0,
  right: 90,
  bottom: 180,
  left: 270,
};

/**
 * Angle of a `to <corner>` gradient.
 *
 * The gradient line for a corner keyword is perpendicular to the diagonal
 * between the *other* two corners, so it depends on the box's aspect ratio —
 * 45° only for a square.
 */
function cornerAngle(vertical: string, horizontal: string, box: GradientBox): number {
  const w = box.w > 0 ? box.w : 1;
  const h = box.h > 0 ? box.h : 1;
  const base = (Math.atan2(w, h) * 180) / Math.PI;
  if (vertical === "top" && horizontal === "right") return base;
  if (vertical === "bottom" && horizontal === "right") return 180 - base;
  if (vertical === "bottom" && horizontal === "left") return 180 + base;
  return 360 - base;
}

function parseDirection(tokens: string[], box: GradientBox): number | null {
  if (tokens[0] !== "to") return null;
  const sides = tokens.slice(1).map((token) => token.toLowerCase());
  if (sides.length === 1) {
    const side = sides[0] ?? "";
    return SIDE_ANGLES[side] ?? null;
  }
  if (sides.length === 2) {
    const [first = "", second = ""] = sides;
    const vertical = first === "top" || first === "bottom" ? first : second;
    const horizontal = first === "left" || first === "right" ? first : second;
    if (
      (vertical === "top" || vertical === "bottom") &&
      (horizontal === "left" || horizontal === "right")
    ) {
      return cornerAngle(vertical, horizontal, box);
    }
  }
  return null;
}

/** Length of the gradient line for a linear gradient at `angle` degrees. */
export function linearGradientLineLength(angle: number, box: GradientBox): number {
  const radians = (angle * Math.PI) / 180;
  return Math.abs(box.w * Math.sin(radians)) + Math.abs(box.h * Math.cos(radians));
}

/**
 * Turns the raw stop list into a normalised, monotonically increasing set of
 * 0-1 offsets, following the CSS rules: the first defaults to 0, the last to
 * 1, out-of-order positions are clamped to the running maximum, and runs of
 * unpositioned stops are distributed evenly between their neighbours.
 */
export function normaliseStops(raw: RawStop[]): GradientStop[] {
  if (raw.length === 0) return [];

  const offsets: Array<number | null> = raw.map((stop) => stop.offset);
  if (offsets[0] === null) offsets[0] = 0;
  if (offsets[offsets.length - 1] === null) offsets[offsets.length - 1] = 1;

  // Positions never decrease along the gradient line.
  let runningMax = offsets[0] ?? 0;
  for (let i = 0; i < offsets.length; i += 1) {
    const offset = offsets[i];
    if (offset === null || offset === undefined) continue;
    if (offset < runningMax) offsets[i] = runningMax;
    else runningMax = offset;
  }

  // Distribute each run of unpositioned stops between its known neighbours.
  let i = 0;
  while (i < offsets.length) {
    if (offsets[i] !== null) {
      i += 1;
      continue;
    }
    let end = i;
    while (end < offsets.length && offsets[end] === null) end += 1;
    const before = offsets[i - 1] ?? 0;
    const after = offsets[end] ?? 1;
    const steps = end - i + 1;
    for (let k = 0; k < end - i; k += 1) {
      offsets[i + k] = before + ((after - before) * (k + 1)) / steps;
    }
    i = end;
  }

  return raw.map((stop, index) => ({
    color: stop.color,
    offset: round(clamp(offsets[index] ?? 0, 0, 1), 4),
  }));
}

function parseStopList(
  entries: string[],
  lineLength: number,
): { stops: RawStop[]; reasons: string[] } {
  const stops: RawStop[] = [];
  const reasons: string[] = [];

  for (const entry of entries) {
    const tokens = splitTopLevelWhitespace(entry);
    if (tokens.length === 0) continue;

    const colorResult = parseColorDetailed(tokens[0] ?? "");
    if (colorResult.color === null) {
      // A bare position between two colours is a colour *hint* (the midpoint
      // of the interpolation), which Illustrator gradients cannot express.
      const hint = parsePercentage(tokens[0] ?? "") ?? parseLength(tokens[0] ?? "");
      if (hint !== null && tokens.length === 1) {
        reasons.push("gradient-color-hint-ignored");
        continue;
      }
      reasons.push(...colorResult.reasons);
      reasons.push("gradient-stop-unparsable");
      continue;
    }
    reasons.push(...colorResult.reasons);

    const positions = tokens.slice(1);
    if (positions.length === 0) {
      stops.push({ color: colorResult.color, offset: null });
      continue;
    }

    // `red 0% 50%` is shorthand for two stops of the same colour.
    for (const position of positions.slice(0, 2)) {
      const fraction = parsePercentage(position);
      const length = fraction === null ? parseLength(position) : null;
      const offset =
        fraction !== null
          ? fraction
          : length !== null && lineLength > 0
            ? length / lineLength
            : null;
      if (offset === null && length !== null) reasons.push("gradient-stop-length-unresolved");
      stops.push({ color: colorResult.color, offset });
    }
  }

  return { stops, reasons };
}

function parseLinear(args: string, box: GradientBox, repeating: boolean): GradientResult {
  const parts = splitTopLevel(args, ",");
  if (parts.length === 0) return { paint: null, reasons: ["gradient-empty"] };

  const reasons: string[] = repeating ? ["gradient-repeating-flattened"] : [];
  let angle = 180; // CSS default is `to bottom`.
  let stopEntries = parts;

  const first = parts[0] ?? "";
  const firstTokens = splitTopLevelWhitespace(first);
  const direction = parseDirection(firstTokens, box);
  if (direction !== null) {
    angle = direction;
    stopEntries = parts.slice(1);
  } else if (firstTokens.length === 1) {
    const explicit = parseAngle(first);
    if (explicit !== null && parseColorDetailed(first).color === null) {
      angle = explicit;
      stopEntries = parts.slice(1);
    }
  }

  const { stops, reasons: stopReasons } = parseStopList(
    stopEntries,
    linearGradientLineLength(angle, box),
  );
  reasons.push(...stopReasons);

  const normalised = normaliseStops(stops);
  if (normalised.length < 2)
    return { paint: null, reasons: [...reasons, "gradient-too-few-stops"] };

  return {
    paint: {
      kind: "linear-gradient",
      angle: round(((angle % 360) + 360) % 360, 3),
      stops: normalised,
    },
    reasons,
  };
}

interface RadialGeometry {
  shape: "circle" | "ellipse";
  cx: number;
  cy: number;
  rx: number;
  ry: number;
}

function resolvePositionComponent(token: string, basis: number, axis: "x" | "y"): number | null {
  const keyword = token.toLowerCase();
  if (keyword === "center") return basis / 2;
  if (axis === "x") {
    if (keyword === "left") return 0;
    if (keyword === "right") return basis;
  } else {
    if (keyword === "top") return 0;
    if (keyword === "bottom") return basis;
  }
  return parseLengthOrPercentage(token, basis);
}

function radialRadii(
  shape: "circle" | "ellipse",
  size: string,
  cx: number,
  cy: number,
  box: GradientBox,
): { rx: number; ry: number } {
  const left = cx;
  const right = Math.max(box.w - cx, 0);
  const top = cy;
  const bottom = Math.max(box.h - cy, 0);

  const closestSideX = Math.min(left, right);
  const closestSideY = Math.min(top, bottom);
  const farthestSideX = Math.max(left, right);
  const farthestSideY = Math.max(top, bottom);

  const cornerDistance = (pickFarthest: boolean): { dx: number; dy: number } => ({
    dx: pickFarthest ? farthestSideX : closestSideX,
    dy: pickFarthest ? farthestSideY : closestSideY,
  });

  if (shape === "circle") {
    switch (size) {
      case "closest-side":
        return {
          rx: Math.min(closestSideX, closestSideY),
          ry: Math.min(closestSideX, closestSideY),
        };
      case "farthest-side":
        return {
          rx: Math.max(farthestSideX, farthestSideY),
          ry: Math.max(farthestSideX, farthestSideY),
        };
      case "closest-corner": {
        const { dx, dy } = cornerDistance(false);
        const r = Math.hypot(dx, dy);
        return { rx: r, ry: r };
      }
      default: {
        const { dx, dy } = cornerDistance(true);
        const r = Math.hypot(dx, dy);
        return { rx: r, ry: r };
      }
    }
  }

  switch (size) {
    case "closest-side":
      return { rx: closestSideX, ry: closestSideY };
    case "farthest-side":
      return { rx: farthestSideX, ry: farthestSideY };
    case "closest-corner":
    case "farthest-corner":
    default: {
      // The corner ellipse keeps the aspect ratio of the matching side
      // ellipse and is scaled until it passes through the corner.
      const farthest = size !== "closest-corner";
      const sx = farthest ? farthestSideX : closestSideX;
      const sy = farthest ? farthestSideY : closestSideY;
      const { dx, dy } = cornerDistance(farthest);
      if (sx === 0 || sy === 0) return { rx: dx, ry: dy };
      const scale = Math.hypot(dx / sx, dy / sy);
      return { rx: sx * scale, ry: sy * scale };
    }
  }
}

function parseRadialGeometry(
  header: string,
  box: GradientBox,
): { geometry: RadialGeometry; reasons: string[] } {
  const reasons: string[] = [];
  const [beforeAt, afterAt] = splitHeaderAt(header);

  let shape: "circle" | "ellipse" = "ellipse";
  let size = "farthest-corner";
  const explicitRadii: number[] = [];

  for (const token of splitTopLevelWhitespace(beforeAt)) {
    const lower = token.toLowerCase();
    if (lower === "circle" || lower === "ellipse") {
      shape = lower;
      continue;
    }
    if (
      lower === "closest-side" ||
      lower === "farthest-side" ||
      lower === "closest-corner" ||
      lower === "farthest-corner"
    ) {
      size = lower;
      continue;
    }
    const radius = parseLengthOrPercentage(token, explicitRadii.length === 0 ? box.w : box.h);
    if (radius !== null) explicitRadii.push(radius);
  }

  let cx = box.w / 2;
  let cy = box.h / 2;
  if (afterAt !== undefined) {
    const tokens = splitTopLevelWhitespace(afterAt);
    const x = resolvePositionComponent(tokens[0] ?? "center", box.w, "x");
    const y = resolvePositionComponent(tokens[1] ?? "center", box.h, "y");
    if (x !== null) cx = x;
    if (y !== null) cy = y;
  }

  if (explicitRadii.length > 0) {
    const rx = explicitRadii[0] ?? 0;
    const ry = shape === "circle" ? rx : (explicitRadii[1] ?? rx);
    return { geometry: { shape, cx, cy, rx, ry }, reasons };
  }

  const { rx, ry } = radialRadii(shape, size, cx, cy, box);
  return { geometry: { shape, cx, cy, rx, ry }, reasons };
}

/** Splits a radial header into the part before and after the `at` keyword. */
function splitHeaderAt(header: string): [string, string | undefined] {
  const tokens = splitTopLevelWhitespace(header);
  const index = tokens.findIndex((token) => token.toLowerCase() === "at");
  if (index === -1) return [header, undefined];
  return [tokens.slice(0, index).join(" "), tokens.slice(index + 1).join(" ")];
}

function parseRadial(args: string, box: GradientBox, repeating: boolean): GradientResult {
  const parts = splitTopLevel(args, ",");
  if (parts.length === 0) return { paint: null, reasons: ["gradient-empty"] };

  const reasons: string[] = repeating ? ["gradient-repeating-flattened"] : [];
  let stopEntries = parts;
  let geometry: RadialGeometry = {
    shape: "ellipse",
    cx: box.w / 2,
    cy: box.h / 2,
    ...radialRadii("ellipse", "farthest-corner", box.w / 2, box.h / 2, box),
  };

  const first = parts[0] ?? "";
  const looksLikeHeader =
    parseColorDetailed(splitTopLevelWhitespace(first)[0] ?? "").color === null &&
    /circle|ellipse|closest|farthest|\bat\b|^\s*\d/.test(first.toLowerCase());
  if (looksLikeHeader) {
    const parsed = parseRadialGeometry(first, box);
    geometry = parsed.geometry;
    reasons.push(...parsed.reasons);
    stopEntries = parts.slice(1);
  }

  const { stops, reasons: stopReasons } = parseStopList(
    stopEntries,
    Math.max(geometry.rx, geometry.ry),
  );
  reasons.push(...stopReasons);

  const normalised = normaliseStops(stops);
  if (normalised.length < 2)
    return { paint: null, reasons: [...reasons, "gradient-too-few-stops"] };

  const safeW = box.w > 0 ? box.w : 1;
  const safeH = box.h > 0 ? box.h : 1;
  return {
    paint: {
      kind: "radial-gradient",
      shape: geometry.shape,
      center: { x: round(geometry.cx / safeW, 4), y: round(geometry.cy / safeH, 4) },
      radius: { x: round(geometry.rx / safeW, 4), y: round(geometry.ry / safeH, 4) },
      stops: normalised,
    },
    reasons,
  };
}

/**
 * Parses a CSS gradient into a `Paint`.
 *
 * `box` is the element's border box: gradients resolve percentages, corner
 * angles and `closest-side`-style radii against it, so the same gradient
 * string produces different geometry in different boxes.
 */
export function parseGradient(input: string, box: GradientBox): GradientResult {
  const fn = parseFunction(input.trim());
  if (fn === null) return { paint: null, reasons: [] };

  switch (fn.name) {
    case "linear-gradient":
      return parseLinear(fn.args, box, false);
    case "repeating-linear-gradient":
      return parseLinear(fn.args, box, true);
    case "radial-gradient":
      return parseRadial(fn.args, box, false);
    case "repeating-radial-gradient":
      return parseRadial(fn.args, box, true);
    case "conic-gradient":
    case "repeating-conic-gradient":
      return { paint: null, reasons: ["gradient-conic-unsupported"] };
    default:
      return { paint: null, reasons: [] };
  }
}

/** True when the value is any kind of CSS gradient function. */
export function isGradient(input: string): boolean {
  return /^(repeating-)?(linear|radial|conic)-gradient\(/i.test(input.trim());
}
