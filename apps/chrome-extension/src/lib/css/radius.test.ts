import { describe, expect, it } from "vitest";
import { isSquare, isUniform, parseBorderRadius } from "./radius.ts";

const corners = (
  topLeft: string,
  topRight = topLeft,
  bottomRight = topLeft,
  bottomLeft = topLeft,
) => ({ topLeft, topRight, bottomRight, bottomLeft });

describe("parseBorderRadius", () => {
  it("parses uniform pixel radii", () => {
    const result = parseBorderRadius(corners("8px"), { w: 200, h: 100 });
    expect(result.radius).toEqual([8, 8, 8, 8]);
    expect(result.reasons).toEqual([]);
  });

  it("keeps the CSS corner order (TL, TR, BR, BL)", () => {
    const result = parseBorderRadius(corners("1px", "2px", "3px", "4px"), { w: 200, h: 100 });
    expect(result.radius).toEqual([1, 2, 3, 4]);
  });

  it("resolves percentages per axis", () => {
    const result = parseBorderRadius(corners("50%"), { w: 200, h: 100 });
    // Horizontal radius resolves against the width.
    expect(result.radius).toEqual([100, 100, 100, 100]);
    expect(result.reasons).toContain("radius-elliptical-approximated");
  });

  it("scales overlapping radii down, which is what makes a pill a pill", () => {
    const result = parseBorderRadius(corners("9999px"), { w: 200, h: 100 });
    // Both top corners want 9999px across a 200px edge, so everything is
    // scaled by 200/19998 — the height is the binding constraint here.
    expect(result.radius[0]).toBeCloseTo(50, 3);
    expect(result.reasons).toContain("radius-scaled-to-fit");
  });

  it("reports elliptical corners it had to flatten", () => {
    const result = parseBorderRadius(corners("20px 10px"), { w: 200, h: 100 });
    expect(result.radius).toEqual([20, 20, 20, 20]);
    expect(result.reasons).toContain("radius-elliptical-approximated");
  });

  it("treats an unparsable corner as square and says so", () => {
    const result = parseBorderRadius(corners("inherit"), { w: 100, h: 100 });
    expect(result.radius).toEqual([0, 0, 0, 0]);
    expect(result.reasons).toContain("radius-unparsable");
  });

  it("does not report the common all-zero case", () => {
    expect(parseBorderRadius(corners("0px"), { w: 100, h: 100 }).reasons).toEqual([]);
  });

  it("survives a zero-sized box", () => {
    const result = parseBorderRadius(corners("10px"), { w: 0, h: 0 });
    expect(result.radius).toEqual([10, 10, 10, 10]);
  });
});

describe("radius predicates", () => {
  it("detects square and uniform corners", () => {
    expect(isSquare([0, 0, 0, 0])).toBe(true);
    expect(isSquare([0, 1, 0, 0])).toBe(false);
    expect(isUniform([4, 4, 4, 4])).toBe(true);
    expect(isUniform([4, 4, 4, 5])).toBe(false);
  });
});
