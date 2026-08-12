import { describe, expect, it } from "vitest";
import { parseBoxShadow, parseTextShadow } from "./shadow.ts";

describe("parseBoxShadow", () => {
  it("parses the colour-first form getComputedStyle emits", () => {
    const result = parseBoxShadow("rgba(0, 0, 0, 0.5) 0px 4px 8px 0px");
    expect(result.shadows).toEqual([
      {
        inset: false,
        offsetX: 0,
        offsetY: 4,
        blur: 8,
        spread: 0,
        color: { r: 0, g: 0, b: 0, a: 0.5 },
      },
    ]);
  });

  it("parses the authored colour-last form", () => {
    const result = parseBoxShadow("2px 3px 4px 1px #ff0000");
    expect(result.shadows[0]).toMatchObject({
      offsetX: 2,
      offsetY: 3,
      blur: 4,
      spread: 1,
      color: { r: 255, g: 0, b: 0, a: 1 },
    });
  });

  it("handles a two-length shadow", () => {
    expect(parseBoxShadow("red 1px 2px").shadows[0]).toMatchObject({
      offsetX: 1,
      offsetY: 2,
      blur: 0,
      spread: 0,
    });
  });

  it("picks up inset wherever it appears", () => {
    expect(parseBoxShadow("inset 0 0 4px red").shadows[0]?.inset).toBe(true);
    expect(parseBoxShadow("0 0 4px red inset").shadows[0]?.inset).toBe(true);
    expect(parseBoxShadow("inset 0 0 4px red").reasons).toContain("shadow-inset");
  });

  it("splits multiple shadows and flags them", () => {
    const result = parseBoxShadow(
      "rgb(0, 0, 0) 0px 1px 2px 0px, rgba(0, 0, 0, 0.2) 0px 8px 16px 0px",
    );
    expect(result.shadows).toHaveLength(2);
    expect(result.shadows[1]).toMatchObject({ offsetY: 8, blur: 16 });
    expect(result.reasons).toContain("shadow-multiple");
  });

  it("returns nothing for none", () => {
    expect(parseBoxShadow("none")).toEqual({ shadows: [], reasons: [] });
    expect(parseBoxShadow("")).toEqual({ shadows: [], reasons: [] });
  });

  it("reports a defaulted colour rather than pretending it knew", () => {
    const result = parseBoxShadow("0 2px 4px");
    expect(result.shadows[0]?.color).toEqual({ r: 0, g: 0, b: 0, a: 1 });
    expect(result.reasons).toContain("shadow-color-defaulted");
  });

  it("clamps a negative blur to zero", () => {
    expect(parseBoxShadow("red 0 0 -5px").shadows[0]?.blur).toBe(0);
  });

  it("reports an entry it cannot read instead of dropping it silently", () => {
    const result = parseBoxShadow("red");
    expect(result.shadows).toHaveLength(0);
    expect(result.reasons).toContain("shadow-unparsable");
  });
});

describe("parseTextShadow", () => {
  it("drops spread and inset, which text-shadow does not have", () => {
    const result = parseTextShadow("rgba(0, 0, 0, 0.4) 1px 1px 3px");
    expect(result.shadows[0]).toMatchObject({ spread: 0, inset: false, blur: 3 });
    expect(result.reasons).not.toContain("shadow-inset");
  });
});
