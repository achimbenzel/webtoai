import {
  parseAngle,
  parseFunction,
  parseLength,
  parseLengthOrPercentage,
  round,
  splitTopLevel,
  splitTopLevelWhitespace,
} from "./values.ts";

/** A 2D affine matrix in CSS order: [a, b, c, d, e, f]. */
export type Matrix2D = [number, number, number, number, number, number];

export const IDENTITY: Matrix2D = [1, 0, 0, 1, 0, 0];

export interface TransformResult {
  matrix: Matrix2D | null;
  reasons: string[];
}

/** The box a transform resolves percentage translations against. */
export interface TransformBox {
  w: number;
  h: number;
}

/** `m1 · m2`, i.e. apply m2 first, then m1 — the CSS composition order. */
export function multiply(m1: Matrix2D, m2: Matrix2D): Matrix2D {
  const [a1, b1, c1, d1, e1, f1] = m1;
  const [a2, b2, c2, d2, e2, f2] = m2;
  return [
    a1 * a2 + c1 * b2,
    b1 * a2 + d1 * b2,
    a1 * c2 + c1 * d2,
    b1 * c2 + d1 * d2,
    a1 * e2 + c1 * f2 + e1,
    b1 * e2 + d1 * f2 + f1,
  ];
}

export function isIdentity(matrix: Matrix2D, epsilon = 1e-6): boolean {
  return matrix.every((value, index) => Math.abs(value - (IDENTITY[index] ?? 0)) < epsilon);
}

function degreesToRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

function numberArgs(args: string): string[] {
  return splitTopLevel(args, ",");
}

/**
 * A `matrix3d` is representable in 2D only when it has no depth component:
 * every z row/column must be the identity's.
 */
function matrix3dTo2d(values: number[]): Matrix2D | null {
  if (values.length !== 16) return null;
  const at = (index: number): number => values[index] ?? 0;
  const flatEnough =
    Math.abs(at(2)) < 1e-6 &&
    Math.abs(at(3)) < 1e-6 &&
    Math.abs(at(6)) < 1e-6 &&
    Math.abs(at(7)) < 1e-6 &&
    Math.abs(at(8)) < 1e-6 &&
    Math.abs(at(9)) < 1e-6 &&
    Math.abs(at(10) - 1) < 1e-6 &&
    Math.abs(at(11)) < 1e-6 &&
    Math.abs(at(14)) < 1e-6 &&
    Math.abs(at(15) - 1) < 1e-6;
  if (!flatEnough) return null;
  return [at(0), at(1), at(4), at(5), at(12), at(13)];
}

function applyFunction(name: string, args: string, box: TransformBox): TransformResult {
  const parts = numberArgs(args);
  const numeric = (index: number): number | null => {
    const token = parts[index];
    if (token === undefined) return null;
    const asNumber = Number(token.trim());
    return Number.isFinite(asNumber) ? asNumber : null;
  };

  switch (name) {
    case "matrix": {
      const values = parts.map((part) => Number(part.trim()));
      if (values.length !== 6 || values.some((value) => !Number.isFinite(value))) {
        return { matrix: null, reasons: ["transform-unparsable"] };
      }
      return { matrix: values as Matrix2D, reasons: [] };
    }

    case "matrix3d": {
      const values = parts.map((part) => Number(part.trim()));
      const flattened = matrix3dTo2d(values);
      if (flattened === null) return { matrix: null, reasons: ["transform-3d-unsupported"] };
      return { matrix: flattened, reasons: [] };
    }

    case "translate": {
      const x = parseLengthOrPercentage(parts[0] ?? "0", box.w) ?? 0;
      const y = parts.length > 1 ? (parseLengthOrPercentage(parts[1] ?? "0", box.h) ?? 0) : 0;
      return { matrix: [1, 0, 0, 1, x, y], reasons: [] };
    }
    case "translatex": {
      const x = parseLengthOrPercentage(parts[0] ?? "0", box.w) ?? 0;
      return { matrix: [1, 0, 0, 1, x, 0], reasons: [] };
    }
    case "translatey": {
      const y = parseLengthOrPercentage(parts[0] ?? "0", box.h) ?? 0;
      return { matrix: [1, 0, 0, 1, 0, y], reasons: [] };
    }
    case "translatez":
      return { matrix: IDENTITY, reasons: ["transform-3d-unsupported"] };
    case "translate3d": {
      const z = parseLength(parts[2] ?? "0");
      const x = parseLengthOrPercentage(parts[0] ?? "0", box.w) ?? 0;
      const y = parseLengthOrPercentage(parts[1] ?? "0", box.h) ?? 0;
      return {
        matrix: [1, 0, 0, 1, x, y],
        reasons: z !== null && z !== 0 ? ["transform-3d-unsupported"] : [],
      };
    }

    case "scale": {
      const sx = numeric(0) ?? 1;
      const sy = parts.length > 1 ? (numeric(1) ?? sx) : sx;
      return { matrix: [sx, 0, 0, sy, 0, 0], reasons: [] };
    }
    case "scalex":
      return { matrix: [numeric(0) ?? 1, 0, 0, 1, 0, 0], reasons: [] };
    case "scaley":
      return { matrix: [1, 0, 0, numeric(0) ?? 1, 0, 0], reasons: [] };

    case "rotate":
    case "rotatez": {
      const angle = parseAngle(parts[0] ?? "0");
      if (angle === null) return { matrix: null, reasons: ["transform-unparsable"] };
      const radians = degreesToRadians(angle);
      const cos = Math.cos(radians);
      const sin = Math.sin(radians);
      return { matrix: [cos, sin, -sin, cos, 0, 0], reasons: [] };
    }
    case "rotatex":
    case "rotatey":
    case "rotate3d":
    case "perspective":
      return { matrix: IDENTITY, reasons: ["transform-3d-unsupported"] };

    case "skew": {
      const ax = parseAngle(parts[0] ?? "0") ?? 0;
      const ay = parts.length > 1 ? (parseAngle(parts[1] ?? "0") ?? 0) : 0;
      return {
        matrix: [1, Math.tan(degreesToRadians(ay)), Math.tan(degreesToRadians(ax)), 1, 0, 0],
        reasons: [],
      };
    }
    case "skewx":
      return {
        matrix: [1, 0, Math.tan(degreesToRadians(parseAngle(parts[0] ?? "0") ?? 0)), 1, 0, 0],
        reasons: [],
      };
    case "skewy":
      return {
        matrix: [1, Math.tan(degreesToRadians(parseAngle(parts[0] ?? "0") ?? 0)), 0, 1, 0, 0],
        reasons: [],
      };

    default:
      return { matrix: null, reasons: [`transform-function-unsupported:${name}`] };
  }
}

/**
 * Parses a CSS `transform` into a 2D affine matrix.
 *
 * `getComputedStyle` normally hands back a single `matrix(...)`, but the full
 * function list is supported so the parser also works on authored CSS. 3D
 * transforms that cannot be flattened are refused with a reason — a vector
 * document has no way to express them.
 */
export function parseTransform(input: string, box: TransformBox = { w: 0, h: 0 }): TransformResult {
  const value = input.trim();
  if (value === "" || value.toLowerCase() === "none") return { matrix: null, reasons: [] };

  const reasons: string[] = [];
  let result: Matrix2D = IDENTITY;
  let sawAny = false;

  for (const token of splitTopLevelWhitespace(value)) {
    const fn = parseFunction(token);
    if (fn === null) {
      reasons.push("transform-unparsable");
      continue;
    }
    const applied = applyFunction(fn.name, fn.args, box);
    reasons.push(...applied.reasons);
    if (applied.matrix === null) continue;
    result = multiply(result, applied.matrix);
    sawAny = true;
  }

  if (!sawAny) return { matrix: null, reasons };
  const rounded = result.map((component) => round(component, 6)) as Matrix2D;
  return { matrix: isIdentity(rounded) ? null : rounded, reasons };
}

/**
 * Resolves `transform-origin` (computed form is one or two lengths) to a point
 * relative to the element's border box.
 */
export function parseTransformOrigin(
  input: string,
  box: TransformBox,
): { x: number; y: number } | null {
  const tokens = splitTopLevelWhitespace(input.trim());
  if (tokens.length === 0) return null;
  const x = parseLengthOrPercentage(tokens[0] ?? "", box.w);
  const y = tokens.length > 1 ? parseLengthOrPercentage(tokens[1] ?? "", box.h) : box.h / 2;
  if (x === null || y === null) return null;
  return { x: round(x), y: round(y) };
}
