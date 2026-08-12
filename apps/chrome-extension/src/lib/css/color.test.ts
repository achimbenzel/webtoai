import { describe, expect, it } from "vitest";
import { isTransparent, parseColor, parseColorDetailed } from "./color.ts";

const black = { r: 0, g: 0, b: 0, a: 1 };

describe("parseColor", () => {
  it("parses the rgb()/rgba() forms getComputedStyle emits", () => {
    expect(parseColor("rgb(255, 0, 0)")).toEqual({ r: 255, g: 0, b: 0, a: 1 });
    expect(parseColor("rgba(0, 128, 255, 0.5)")).toEqual({ r: 0, g: 128, b: 255, a: 0.5 });
  });

  it("parses the modern space/slash syntax", () => {
    expect(parseColor("rgb(10 20 30 / 40%)")).toEqual({ r: 10, g: 20, b: 30, a: 0.4 });
    expect(parseColor("rgb(100% 0% 0%)")).toEqual({ r: 255, g: 0, b: 0, a: 1 });
  });

  it("parses hex in all four lengths", () => {
    expect(parseColor("#f00")).toEqual({ r: 255, g: 0, b: 0, a: 1 });
    expect(parseColor("#ff0000")).toEqual({ r: 255, g: 0, b: 0, a: 1 });
    // Alpha is quantised to six decimals so scenes serialise cleanly.
    expect(parseColor("#ff000080")).toEqual({ r: 255, g: 0, b: 0, a: 0.501961 });
    expect(parseColor("#0f08")).toEqual({ r: 0, g: 255, b: 0, a: 0.533333 });
  });

  it("parses named colours", () => {
    expect(parseColor("rebeccapurple")).toEqual({ r: 0x66, g: 0x33, b: 0x99, a: 1 });
    expect(parseColor("WHITE")).toEqual({ r: 255, g: 255, b: 255, a: 1 });
  });

  it("treats transparent as fully transparent black", () => {
    expect(parseColor("transparent")).toEqual({ r: 0, g: 0, b: 0, a: 0 });
    expect(isTransparent(parseColor("transparent"))).toBe(true);
  });

  it("parses hsl()", () => {
    expect(parseColor("hsl(0, 100%, 50%)")).toEqual({ r: 255, g: 0, b: 0, a: 1 });
    expect(parseColor("hsl(120 100% 25%)")).toEqual({ r: 0, g: 128, b: 0, a: 1 });
    expect(parseColor("hsl(210deg 100% 50% / 20%)")).toEqual({ r: 0, g: 128, b: 255, a: 0.2 });
  });

  it("parses hwb()", () => {
    expect(parseColor("hwb(0 0% 0%)")).toEqual({ r: 255, g: 0, b: 0, a: 1 });
    expect(parseColor("hwb(0 100% 0%)")).toEqual({ r: 255, g: 255, b: 255, a: 1 });
  });

  it("converts oklch/oklab into sRGB", () => {
    // Pure white is L=1, C=0 in both spaces.
    expect(parseColor("oklch(1 0 0)")).toEqual({ r: 255, g: 255, b: 255, a: 1 });
    expect(parseColor("oklab(0 0 0)")).toEqual(black);

    const red = parseColor("oklch(0.628 0.2577 29.23)");
    expect(red).not.toBeNull();
    // Round-trip of sRGB red; a couple of levels of drift is expected.
    expect(Math.abs((red?.r ?? 0) - 255)).toBeLessThanOrEqual(2);
    expect(red?.g ?? 99).toBeLessThanOrEqual(2);
    expect(red?.b ?? 99).toBeLessThanOrEqual(2);
  });

  it("handles color(srgb ...)", () => {
    expect(parseColor("color(srgb 1 0 0)")).toEqual({ r: 255, g: 0, b: 0, a: 1 });
    expect(parseColor("color(srgb 0 0 1 / 0.25)")).toEqual({ r: 0, g: 0, b: 255, a: 0.25 });
  });

  it("clips wide-gamut spaces and says so", () => {
    const result = parseColorDetailed("color(display-p3 1 0 0)");
    expect(result.color).not.toBeNull();
    expect(result.reasons).toContain("color-wide-gamut-clipped:display-p3");
  });

  it("refuses colour spaces it cannot convert, with a reason", () => {
    expect(parseColorDetailed("lab(50% 40 59)")).toEqual({
      color: null,
      reasons: ["color-space-unsupported:lab"],
    });
    expect(parseColorDetailed("color-mix(in srgb, red, blue)").reasons).toEqual([
      "color-mix-unsupported",
    ]);
  });

  it("reports currentcolor rather than guessing", () => {
    expect(parseColorDetailed("currentcolor")).toEqual({
      color: null,
      reasons: ["color-currentcolor-unresolved"],
    });
  });

  it("clamps out-of-range components", () => {
    expect(parseColor("rgb(300, -20, 128)")).toEqual({ r: 255, g: 0, b: 128, a: 1 });
    expect(parseColor("rgba(0, 0, 0, 5)")).toEqual({ r: 0, g: 0, b: 0, a: 1 });
  });

  it("returns null for junk", () => {
    expect(parseColor("not-a-color")).toBeNull();
    expect(parseColor("#12345")).toBeNull();
    expect(parseColor("")).toBeNull();
  });
});
