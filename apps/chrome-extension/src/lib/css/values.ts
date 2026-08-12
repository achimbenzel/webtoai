/**
 * Small tokenising helpers shared by the CSS parsers.
 *
 * Everything in `lib/css` is a pure function: string in, schema value out. No
 * DOM, no globals, no side effects — which is what makes them unit-testable
 * without a browser.
 */

/**
 * Splits a CSS value on a separator that appears at nesting depth 0.
 *
 * `linear-gradient(rgb(1, 2, 3), rgb(4, 5, 6))` must not be split on the
 * commas inside `rgb(...)`, which is exactly what a naive `.split(",")` does.
 */
export function splitTopLevel(input: string, separator = ","): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let current = "";

  for (let i = 0; i < input.length; i += 1) {
    const char = input[i] ?? "";

    if (quote !== null) {
      current += char;
      if (char === quote && input[i - 1] !== "\\") quote = null;
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }
    if (char === "(") depth += 1;
    if (char === ")") depth -= 1;

    if (char === separator && depth === 0) {
      parts.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }

  parts.push(current.trim());
  return parts.filter((part) => part.length > 0);
}

/** Splits on runs of whitespace at nesting depth 0. */
export function splitTopLevelWhitespace(input: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let current = "";

  for (let i = 0; i < input.length; i += 1) {
    const char = input[i] ?? "";

    if (quote !== null) {
      current += char;
      if (char === quote && input[i - 1] !== "\\") quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }
    if (char === "(") depth += 1;
    if (char === ")") depth -= 1;

    if (depth === 0 && /\s/.test(char)) {
      if (current.length > 0) parts.push(current);
      current = "";
      continue;
    }
    current += char;
  }

  if (current.length > 0) parts.push(current);
  return parts;
}

export interface CssFunction {
  name: string;
  args: string;
}

/** `linear-gradient(a, b)` → `{ name: "linear-gradient", args: "a, b" }`. */
export function parseFunction(input: string): CssFunction | null {
  const trimmed = input.trim();
  const open = trimmed.indexOf("(");
  if (open <= 0 || !trimmed.endsWith(")")) return null;
  const name = trimmed.slice(0, open).trim().toLowerCase();
  if (!/^[-a-z0-9]+$/.test(name)) return null;
  return { name, args: trimmed.slice(open + 1, -1) };
}

export function stripQuotes(input: string): string {
  const trimmed = input.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === '"' || first === "'") && first === last) return trimmed.slice(1, -1);
  }
  return trimmed;
}

/** Parses a bare `<number>`; returns null for anything else. */
export function parseNumber(input: string): number | null {
  const trimmed = input.trim();
  if (trimmed === "") return null;
  if (!/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(trimmed)) return null;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : null;
}

/** Parses `<percentage>` and returns it as a 0-1 fraction. */
export function parsePercentage(input: string): number | null {
  const trimmed = input.trim();
  if (!trimmed.endsWith("%")) return null;
  const value = parseNumber(trimmed.slice(0, -1));
  return value === null ? null : value / 100;
}

const ABSOLUTE_LENGTH_UNITS: Readonly<Record<string, number>> = {
  px: 1,
  // Absolute CSS units, expressed in CSS pixels (1in = 96px by definition).
  in: 96,
  cm: 96 / 2.54,
  mm: 96 / 25.4,
  q: 96 / 101.6,
  pt: 96 / 72,
  pc: 16,
};

/**
 * Parses a length to CSS pixels.
 *
 * `getComputedStyle` resolves almost everything to `px`, so the other units
 * matter only when these parsers are pointed at authored CSS. Relative units
 * (`em`, `rem`, `vw`, …) cannot be resolved without a context and return null.
 */
export function parseLength(input: string): number | null {
  const trimmed = input.trim().toLowerCase();
  if (trimmed === "0") return 0;
  const match = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)([a-z]+)$/i.exec(trimmed);
  if (match === null) return null;
  const value = Number(match[1]);
  const unit = match[2] ?? "";
  const factor = ABSOLUTE_LENGTH_UNITS[unit];
  if (factor === undefined || !Number.isFinite(value)) return null;
  return value * factor;
}

/**
 * Parses a length or a percentage of `basis`.
 * Returns null when the value is neither.
 */
export function parseLengthOrPercentage(input: string, basis: number): number | null {
  const percentage = parsePercentage(input);
  if (percentage !== null) return percentage * basis;
  return parseLength(input);
}

/** Parses an angle to degrees. Supports deg, grad, rad and turn. */
export function parseAngle(input: string): number | null {
  const trimmed = input.trim().toLowerCase();
  const match = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)(deg|grad|rad|turn)?$/i.exec(trimmed);
  if (match === null) return null;
  const value = Number(match[1]);
  if (!Number.isFinite(value)) return null;
  switch (match[2]) {
    case "grad":
      return (value * 360) / 400;
    case "rad":
      return (value * 180) / Math.PI;
    case "turn":
      return value * 360;
    case "deg":
    case undefined:
      return value;
    default:
      return null;
  }
}

export function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

/** Rounds to `digits` decimals, avoiding -0 and float noise in snapshots. */
export function round(value: number, digits = 3): number {
  const factor = 10 ** digits;
  const rounded = Math.round(value * factor) / factor;
  return rounded === 0 ? 0 : rounded;
}
