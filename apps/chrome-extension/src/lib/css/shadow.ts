import type { Shadow } from "@web2ai/schema";
import { parseColorDetailed } from "./color.ts";
import { parseLength, round, splitTopLevel, splitTopLevelWhitespace } from "./values.ts";

export interface ShadowResult {
  shadows: Shadow[];
  reasons: string[];
}

const DEFAULT_SHADOW_COLOR = { r: 0, g: 0, b: 0, a: 1 };

/**
 * Parses `box-shadow`.
 *
 * The grammar allows the colour and the `inset` keyword anywhere in a shadow,
 * with the lengths in a fixed order — Chrome's computed value puts the colour
 * first (`rgba(0, 0, 0, 0.5) 0px 4px 8px 0px`), authored CSS usually puts it
 * last. Both are handled by pulling out the keyword and colour wherever they
 * are and reading whatever lengths remain positionally.
 */
export function parseBoxShadow(input: string): ShadowResult {
  const value = input.trim();
  if (value === "" || value.toLowerCase() === "none") return { shadows: [], reasons: [] };

  const shadows: Shadow[] = [];
  const reasons: string[] = [];

  for (const entry of splitTopLevel(value, ",")) {
    const tokens = splitTopLevelWhitespace(entry);
    let inset = false;
    let color = DEFAULT_SHADOW_COLOR;
    let sawColor = false;
    const lengths: number[] = [];

    for (const token of tokens) {
      if (token.toLowerCase() === "inset") {
        inset = true;
        continue;
      }
      const length = parseLength(token);
      if (length !== null) {
        lengths.push(length);
        continue;
      }
      const parsed = parseColorDetailed(token);
      reasons.push(...parsed.reasons);
      if (parsed.color !== null) {
        color = parsed.color;
        sawColor = true;
        continue;
      }
      reasons.push("shadow-token-unparsable");
    }

    if (lengths.length < 2) {
      reasons.push("shadow-unparsable");
      continue;
    }
    if (!sawColor) {
      // Without a colour, box-shadow uses `currentColor`, which we cannot see
      // from here. Black is the common case; say so rather than pretend.
      reasons.push("shadow-color-defaulted");
    }

    shadows.push({
      inset,
      offsetX: round(lengths[0] ?? 0),
      offsetY: round(lengths[1] ?? 0),
      blur: round(Math.max(lengths[2] ?? 0, 0)),
      spread: round(lengths[3] ?? 0),
      color,
    });
  }

  if (shadows.length > 1) reasons.push("shadow-multiple");
  if (shadows.some((shadow) => shadow.inset)) reasons.push("shadow-inset");

  return { shadows, reasons };
}

/**
 * Parses `text-shadow`, which shares box-shadow's grammar minus `spread` and
 * `inset`.
 */
export function parseTextShadow(input: string): ShadowResult {
  const result = parseBoxShadow(input);
  return {
    shadows: result.shadows.map((shadow) => ({ ...shadow, spread: 0, inset: false })),
    reasons: result.reasons.filter((reason) => reason !== "shadow-inset"),
  };
}
