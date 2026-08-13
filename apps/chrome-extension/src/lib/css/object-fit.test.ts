import { describe, expect, it } from "vitest";
import { parseObjectFit, parseObjectPosition } from "./object-fit.ts";

const box = { w: 200, h: 100 };

describe("parseObjectFit", () => {
  it("accepts the five keywords", () => {
    expect(parseObjectFit("fill")).toBe("fill");
    expect(parseObjectFit("contain")).toBe("contain");
    expect(parseObjectFit("cover")).toBe("cover");
    expect(parseObjectFit("none")).toBe("none");
    expect(parseObjectFit("scale-down")).toBe("scale-down");
  });

  it("is case- and whitespace-insensitive", () => {
    expect(parseObjectFit("  COVER ")).toBe("cover");
  });

  it("rejects anything else rather than guessing", () => {
    expect(parseObjectFit("")).toBeNull();
    expect(parseObjectFit("inherit")).toBeNull();
    expect(parseObjectFit("cover contain")).toBeNull();
  });
});

describe("parseObjectPosition", () => {
  it("centres by default", () => {
    expect(parseObjectPosition("50% 50%", box).position).toEqual({ x: 0.5, y: 0.5 });
    expect(parseObjectPosition("", box).position).toEqual({ x: 0.5, y: 0.5 });
  });

  it("resolves percentages to a fraction of the leftover space", () => {
    expect(parseObjectPosition("0% 100%", box).position).toEqual({ x: 0, y: 1 });
    expect(parseObjectPosition("25% 75%", box).position).toEqual({ x: 0.25, y: 0.75 });
  });

  it("resolves keywords", () => {
    expect(parseObjectPosition("left top", box).position).toEqual({ x: 0, y: 0 });
    expect(parseObjectPosition("right bottom", box).position).toEqual({ x: 1, y: 1 });
    expect(parseObjectPosition("center center", box).position).toEqual({ x: 0.5, y: 0.5 });
  });

  it("centres the other axis for a single value", () => {
    expect(parseObjectPosition("left", box).position).toEqual({ x: 0, y: 0.5 });
    // "top" names the vertical axis even though it comes first.
    expect(parseObjectPosition("top", box).position).toEqual({ x: 0.5, y: 0 });
  });

  it("reports absolute offsets rather than pretending they are exact", () => {
    // A length is a distance from the box edge to the image edge, which is only
    // the same as a fraction of the leftover space when the image fills the box.
    const result = parseObjectPosition("20px 10px", box);
    expect(result.position).toEqual({ x: 0.1, y: 0.1 });
    expect(result.reasons).toContain("object-position-approximated");
  });

  it("does not report a zero offset, which is exactly flush", () => {
    const result = parseObjectPosition("0px 0px", box);
    expect(result.position).toEqual({ x: 0, y: 0 });
    expect(result.reasons).toEqual([]);
  });

  it("falls back to centre for the edge-relative four-value form", () => {
    const result = parseObjectPosition("right 10px bottom 20px", box);
    expect(result.position).toEqual({ x: 0.5, y: 0.5 });
    expect(result.reasons).toContain("object-position-approximated");
  });

  it("clamps values outside the box", () => {
    expect(parseObjectPosition("150% -50%", box).position).toEqual({ x: 1, y: 0 });
  });
});
