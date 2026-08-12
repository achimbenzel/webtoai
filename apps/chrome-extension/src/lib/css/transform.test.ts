import { describe, expect, it } from "vitest";
import { isIdentity, multiply, parseTransform, parseTransformOrigin } from "./transform.ts";

const box = { w: 200, h: 100 };

describe("parseTransform", () => {
  it("returns null for none", () => {
    expect(parseTransform("none")).toEqual({ matrix: null, reasons: [] });
    expect(parseTransform("")).toEqual({ matrix: null, reasons: [] });
  });

  it("parses the matrix() form getComputedStyle emits", () => {
    expect(parseTransform("matrix(1, 0, 0, 1, 10, 20)").matrix).toEqual([1, 0, 0, 1, 10, 20]);
  });

  it("parses translate with lengths and percentages", () => {
    expect(parseTransform("translate(10px, 20px)", box).matrix).toEqual([1, 0, 0, 1, 10, 20]);
    // Percentages resolve against the element's own box.
    expect(parseTransform("translate(50%, 50%)", box).matrix).toEqual([1, 0, 0, 1, 100, 50]);
    expect(parseTransform("translateX(5px)", box).matrix).toEqual([1, 0, 0, 1, 5, 0]);
  });

  it("parses scale and rotate", () => {
    expect(parseTransform("scale(2)").matrix).toEqual([2, 0, 0, 2, 0, 0]);
    expect(parseTransform("scale(2, 3)").matrix).toEqual([2, 0, 0, 3, 0, 0]);
    const rotated = parseTransform("rotate(90deg)").matrix;
    expect(rotated?.[0]).toBeCloseTo(0, 5);
    expect(rotated?.[1]).toBeCloseTo(1, 5);
    expect(rotated?.[2]).toBeCloseTo(-1, 5);
  });

  it("composes a function list left to right", () => {
    // translate then scale: the translation is not scaled.
    const matrix = parseTransform("translate(10px, 0) scale(2)", box).matrix;
    expect(matrix).toEqual([2, 0, 0, 2, 10, 0]);
    // The other order scales the translation.
    const reversed = parseTransform("scale(2) translate(10px, 0)", box).matrix;
    expect(reversed).toEqual([2, 0, 0, 2, 20, 0]);
  });

  it("flattens a matrix3d that has no depth", () => {
    const flat = "matrix3d(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 12, 34, 0, 1)";
    expect(parseTransform(flat).matrix).toEqual([1, 0, 0, 1, 12, 34]);
  });

  it("refuses a matrix3d with real depth", () => {
    const rotated = "matrix3d(1, 0, 0, 0, 0, 0.7, 0.7, 0, 0, -0.7, 0.7, 0, 0, 0, 0, 1)";
    const result = parseTransform(rotated);
    expect(result.matrix).toBeNull();
    expect(result.reasons).toContain("transform-3d-unsupported");
  });

  it("reports 3D functions instead of approximating them", () => {
    expect(parseTransform("rotateX(45deg)").reasons).toContain("transform-3d-unsupported");
    expect(parseTransform("perspective(500px)").reasons).toContain("transform-3d-unsupported");
  });

  it("treats an identity result as no transform", () => {
    expect(parseTransform("translate(0, 0)").matrix).toBeNull();
    expect(parseTransform("scale(1)").matrix).toBeNull();
  });

  it("reports unknown functions", () => {
    expect(parseTransform("wobble(3)").reasons).toContain("transform-function-unsupported:wobble");
  });

  it("parses skew", () => {
    const matrix = parseTransform("skewX(45deg)").matrix;
    expect(matrix?.[2]).toBeCloseTo(1, 5);
  });
});

describe("multiply", () => {
  it("is identity-neutral", () => {
    const m: [number, number, number, number, number, number] = [2, 0, 0, 3, 5, 7];
    expect(multiply([1, 0, 0, 1, 0, 0], m)).toEqual(m);
    expect(multiply(m, [1, 0, 0, 1, 0, 0])).toEqual(m);
  });

  it("detects identity within an epsilon", () => {
    expect(isIdentity([1, 0, 0, 1, 0, 0])).toBe(true);
    expect(isIdentity([1, 0, 0, 1, 1e-9, 0])).toBe(true);
    expect(isIdentity([1, 0, 0, 1, 0.5, 0])).toBe(false);
  });
});

describe("parseTransformOrigin", () => {
  it("resolves lengths and percentages against the box", () => {
    expect(parseTransformOrigin("10px 20px", box)).toEqual({ x: 10, y: 20 });
    expect(parseTransformOrigin("50% 100%", box)).toEqual({ x: 100, y: 100 });
  });

  it("defaults the vertical component to the centre", () => {
    expect(parseTransformOrigin("0px", box)).toEqual({ x: 0, y: 50 });
  });

  it("returns null for values it cannot resolve", () => {
    expect(parseTransformOrigin("left top", box)).toBeNull();
  });
});
