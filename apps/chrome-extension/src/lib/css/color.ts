import type { RGBA } from "@web2ai/schema";
import { NAMED_COLORS } from "./named-colors.ts";
import {
  clamp,
  parseFunction,
  parseNumber,
  parsePercentage,
  round,
  splitTopLevel,
  splitTopLevelWhitespace,
} from "./values.ts";

export interface ColorResult {
  color: RGBA | null;
  /** Reason codes for anything that was approximated or refused. */
  reasons: string[];
}

export const TRANSPARENT: RGBA = { r: 0, g: 0, b: 0, a: 0 };

/**
 * Channel values arrive with float noise — the hsl() conversion produces
 * 127.49999999999996 where the browser reports 128 — so each one is snapped to
 * six decimals before the final rounding. Without that, values that land
 * exactly on .5 round the wrong way.
 */
function quantise(value: number): number {
  return Math.round(clamp(round(value, 6), 0, 255));
}

function rgba(r: number, g: number, b: number, a: number): RGBA {
  return {
    r: quantise(r),
    g: quantise(g),
    b: quantise(b),
    a: clamp(round(a, 6), 0, 1),
  };
}

/** `<number> | <percentage>` in an rgb() channel, scaled to 0-255. */
function channel(token: string): number | null {
  const percentage = parsePercentage(token);
  if (percentage !== null) return percentage * 255;
  if (token.trim() === "none") return 0;
  return parseNumber(token);
}

/** `<number> | <percentage>` in an alpha slot, scaled to 0-1. */
function alphaValue(token: string | undefined): number {
  if (token === undefined) return 1;
  const trimmed = token.trim();
  if (trimmed === "" || trimmed === "none") return 1;
  const percentage = parsePercentage(trimmed);
  if (percentage !== null) return clamp(percentage, 0, 1);
  const number = parseNumber(trimmed);
  return number === null ? 1 : clamp(number, 0, 1);
}

/**
 * Splits colour function arguments, accepting both the legacy comma syntax
 * (`rgb(1, 2, 3)`) and the modern space/slash syntax (`rgb(1 2 3 / 50%)`).
 */
function splitColorArgs(args: string): { components: string[]; alpha: string | undefined } {
  if (args.includes("/")) {
    const [head = "", tail] = splitTopLevel(args, "/");
    return { components: splitTopLevelWhitespace(head), alpha: tail };
  }
  const commaParts = splitTopLevel(args, ",");
  if (commaParts.length > 1) {
    return { components: commaParts.slice(0, 3), alpha: commaParts[3] };
  }
  const spaceParts = splitTopLevelWhitespace(args);
  return { components: spaceParts.slice(0, 3), alpha: spaceParts[3] };
}

function hueToRgb(p: number, q: number, tIn: number): number {
  let t = tIn;
  if (t < 0) t += 1;
  if (t > 1) t -= 1;
  if (t < 1 / 6) return p + (q - p) * 6 * t;
  if (t < 1 / 2) return q;
  if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
  return p;
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const hue = (((h % 360) + 360) % 360) / 360;
  if (s === 0) return [l * 255, l * 255, l * 255];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return [
    hueToRgb(p, q, hue + 1 / 3) * 255,
    hueToRgb(p, q, hue) * 255,
    hueToRgb(p, q, hue - 1 / 3) * 255,
  ];
}

/** Linear-light sRGB component → gamma-encoded 0-255. */
function encodeSrgb(linear: number): number {
  const magnitude = Math.abs(linear);
  const encoded =
    magnitude <= 0.0031308 ? 12.92 * magnitude : 1.055 * magnitude ** (1 / 2.4) - 0.055;
  return Math.sign(linear) * encoded * 255;
}

/** Oklab → linear sRGB, per the Oklab specification. */
function oklabToRgb(L: number, a: number, b: number): [number, number, number] {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    encodeSrgb(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    encodeSrgb(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    encodeSrgb(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  ];
}

function parseHex(input: string): RGBA | null {
  const hex = input.slice(1);
  if (!/^[0-9a-f]+$/i.test(hex)) return null;

  const expand = (char: string): number => parseInt(char + char, 16);
  if (hex.length === 3 || hex.length === 4) {
    const [r = "0", g = "0", b = "0", a] = hex.split("");
    return rgba(expand(r), expand(g), expand(b), a === undefined ? 1 : expand(a) / 255);
  }
  if (hex.length === 6 || hex.length === 8) {
    const value = (offset: number): number => parseInt(hex.slice(offset, offset + 2), 16);
    return rgba(value(0), value(2), value(4), hex.length === 8 ? value(6) / 255 : 1);
  }
  return null;
}

/**
 * Parses any CSS colour into sRGB.
 *
 * `getComputedStyle` normalises most colours to `rgb()`/`rgba()`, but not all:
 * wide-gamut and Oklab colours come back in their authored space, so those are
 * converted here rather than dropped. Colour spaces that need a full CIE
 * pipeline (`lab`, `lch`) and context-dependent keywords (`currentcolor`) are
 * refused with a reason instead of being guessed at.
 */
export function parseColorDetailed(input: string): ColorResult {
  const value = input.trim();
  if (value === "") return { color: null, reasons: [] };

  const lower = value.toLowerCase();

  if (lower === "transparent") return { color: TRANSPARENT, reasons: [] };
  if (lower === "currentcolor") {
    return { color: null, reasons: ["color-currentcolor-unresolved"] };
  }
  if (lower === "none") return { color: null, reasons: [] };

  const named = NAMED_COLORS[lower];
  if (named !== undefined) {
    return {
      color: rgba((named >> 16) & 0xff, (named >> 8) & 0xff, named & 0xff, 1),
      reasons: [],
    };
  }

  if (value.startsWith("#")) {
    const hex = parseHex(value);
    return hex === null
      ? { color: null, reasons: ["color-unparsable"] }
      : { color: hex, reasons: [] };
  }

  const fn = parseFunction(value);
  if (fn === null) return { color: null, reasons: ["color-unparsable"] };

  const { components, alpha } = splitColorArgs(fn.args);
  const a = alphaValue(alpha);

  switch (fn.name) {
    case "rgb":
    case "rgba": {
      const r = channel(components[0] ?? "");
      const g = channel(components[1] ?? "");
      const b = channel(components[2] ?? "");
      if (r === null || g === null || b === null)
        return { color: null, reasons: ["color-unparsable"] };
      return { color: rgba(r, g, b, a), reasons: [] };
    }

    case "hsl":
    case "hsla": {
      const h = parseNumber((components[0] ?? "").replace(/deg$/i, ""));
      const s = parsePercentage(components[1] ?? "") ?? parseNumber(components[1] ?? "");
      const l = parsePercentage(components[2] ?? "") ?? parseNumber(components[2] ?? "");
      if (h === null || s === null || l === null)
        return { color: null, reasons: ["color-unparsable"] };
      const [r, g, b] = hslToRgb(h, clamp(s, 0, 1), clamp(l, 0, 1));
      return { color: rgba(r, g, b, a), reasons: [] };
    }

    case "hwb": {
      const h = parseNumber((components[0] ?? "").replace(/deg$/i, ""));
      const w = parsePercentage(components[1] ?? "");
      const b = parsePercentage(components[2] ?? "");
      if (h === null || w === null || b === null)
        return { color: null, reasons: ["color-unparsable"] };
      if (w + b >= 1) {
        const grey = (w / (w + b)) * 255;
        return { color: rgba(grey, grey, grey, a), reasons: [] };
      }
      const [hr, hg, hb] = hslToRgb(h, 1, 0.5);
      const mix = (channelValue: number): number =>
        (channelValue / 255) * (1 - w - b) * 255 + w * 255;
      return { color: rgba(mix(hr), mix(hg), mix(hb), a), reasons: [] };
    }

    case "oklab": {
      const L = parsePercentage(components[0] ?? "") ?? parseNumber(components[0] ?? "");
      const aValue = parseNumber(components[1] ?? "");
      const bValue = parseNumber(components[2] ?? "");
      if (L === null || aValue === null || bValue === null) {
        return { color: null, reasons: ["color-unparsable"] };
      }
      const [r, g, b] = oklabToRgb(L, aValue, bValue);
      return { color: rgba(r, g, b, a), reasons: [] };
    }

    case "oklch": {
      const L = parsePercentage(components[0] ?? "") ?? parseNumber(components[0] ?? "");
      const c = parseNumber(components[1] ?? "");
      const h = parseNumber((components[2] ?? "").replace(/deg$/i, ""));
      if (L === null || c === null || h === null)
        return { color: null, reasons: ["color-unparsable"] };
      const radians = (h * Math.PI) / 180;
      const [r, g, b] = oklabToRgb(L, c * Math.cos(radians), c * Math.sin(radians));
      return { color: rgba(r, g, b, a), reasons: [] };
    }

    case "color": {
      // color(<colorspace> c1 c2 c3 [/ alpha]) — the colour space occupies the
      // first slot, so the generic component/alpha split above misreads c3 as
      // the alpha. Re-split here.
      const slashParts = splitTopLevel(fn.args, "/");
      const tokens = splitTopLevelWhitespace(slashParts[0] ?? "");
      const colorAlpha = alphaValue(slashParts[1]);
      const space = (tokens[0] ?? "").toLowerCase();
      const nums = tokens.slice(1, 4).map((token) => parsePercentage(token) ?? parseNumber(token));
      if (nums.length < 3 || nums.some((n) => n === null)) {
        return { color: null, reasons: ["color-unparsable"] };
      }
      const [c1, c2, c3] = nums as [number, number, number];
      if (space === "srgb") {
        return { color: rgba(c1 * 255, c2 * 255, c3 * 255, colorAlpha), reasons: [] };
      }
      if (space === "srgb-linear") {
        return {
          color: rgba(encodeSrgb(c1), encodeSrgb(c2), encodeSrgb(c3), colorAlpha),
          reasons: [],
        };
      }
      // display-p3 / rec2020 / a98-rgb share sRGB's transfer curve shape but a
      // wider primary set. Treating them as sRGB clips saturation rather than
      // failing outright — flagged so the report says so.
      return {
        color: rgba(c1 * 255, c2 * 255, c3 * 255, colorAlpha),
        reasons: [`color-wide-gamut-clipped:${space}`],
      };
    }

    case "lab":
    case "lch":
      return { color: null, reasons: [`color-space-unsupported:${fn.name}`] };

    case "color-mix":
      return { color: null, reasons: ["color-mix-unsupported"] };

    default:
      return { color: null, reasons: ["color-unparsable"] };
  }
}

/** Convenience wrapper for call sites that do not collect reasons. */
export function parseColor(input: string): RGBA | null {
  return parseColorDetailed(input).color;
}

/** True when the colour contributes nothing visible. */
export function isTransparent(color: RGBA | null): boolean {
  return color === null || color.a === 0;
}
