import { describe, expect, it } from "vitest";
import { isGradient, linearGradientLineLength, normaliseStops, parseGradient } from "./gradient.ts";

const box = { w: 200, h: 100 };
const square = { w: 100, h: 100 };

const red = { r: 255, g: 0, b: 0, a: 1 };
const blue = { r: 0, g: 0, b: 255, a: 1 };

describe("parseGradient — linear", () => {
  it("parses the form getComputedStyle emits", () => {
    const result = parseGradient("linear-gradient(rgb(255, 0, 0), rgb(0, 0, 255))", box);
    expect(result.paint).toEqual({
      kind: "linear-gradient",
      // No direction given means `to bottom`, which is 180deg.
      angle: 180,
      stops: [
        { color: red, offset: 0 },
        { color: blue, offset: 1 },
      ],
    });
  });

  it("reads an explicit angle", () => {
    const result = parseGradient("linear-gradient(45deg, red, blue)", box);
    expect(result.paint).toMatchObject({ kind: "linear-gradient", angle: 45 });
  });

  it("normalises negative and over-360 angles", () => {
    expect(parseGradient("linear-gradient(-90deg, red, blue)", box).paint).toMatchObject({
      angle: 270,
    });
    expect(parseGradient("linear-gradient(450deg, red, blue)", box).paint).toMatchObject({
      angle: 90,
    });
  });

  it("maps the side keywords", () => {
    const cases: Array<[string, number]> = [
      ["to top", 0],
      ["to right", 90],
      ["to bottom", 180],
      ["to left", 270],
    ];
    for (const [keyword, angle] of cases) {
      expect(parseGradient(`linear-gradient(${keyword}, red, blue)`, box).paint).toMatchObject({
        angle,
      });
    }
  });

  it("computes corner angles from the box aspect ratio, not a flat 45deg", () => {
    // A square really is 45deg…
    expect(parseGradient("linear-gradient(to top right, red, blue)", square).paint).toMatchObject({
      angle: 45,
    });
    // …but a 2:1 box is not.
    const wide = parseGradient("linear-gradient(to top right, red, blue)", box).paint;
    expect(wide).toMatchObject({ kind: "linear-gradient" });
    if (wide?.kind !== "linear-gradient") throw new Error("expected a linear gradient");
    expect(wide.angle).toBeCloseTo(63.435, 2);
  });

  it("resolves percentage stops", () => {
    const result = parseGradient("linear-gradient(90deg, red 20%, blue 80%)", box);
    expect(result.paint).toMatchObject({
      stops: [
        { color: red, offset: 0.2 },
        { color: blue, offset: 0.8 },
      ],
    });
  });

  it("resolves pixel stops against the gradient line length", () => {
    // `to right` on a 200px-wide box gives a 200px gradient line.
    const result = parseGradient("linear-gradient(to right, red 50px, blue 150px)", box);
    expect(result.paint).toMatchObject({
      stops: [
        { color: red, offset: 0.25 },
        { color: blue, offset: 0.75 },
      ],
    });
  });

  it("expands a double-position stop into two stops", () => {
    const result = parseGradient("linear-gradient(red 0% 50%, blue 50% 100%)", box);
    expect(result.paint).toMatchObject({
      stops: [
        { color: red, offset: 0 },
        { color: red, offset: 0.5 },
        { color: blue, offset: 0.5 },
        { color: blue, offset: 1 },
      ],
    });
  });

  it("reports colour hints instead of silently misplacing them", () => {
    const result = parseGradient("linear-gradient(red, 30%, blue)", box);
    expect(result.reasons).toContain("gradient-color-hint-ignored");
    expect(result.paint).toMatchObject({
      stops: [
        { color: red, offset: 0 },
        { color: blue, offset: 1 },
      ],
    });
  });

  it("flags repeating gradients as flattened", () => {
    const result = parseGradient("repeating-linear-gradient(red 0px, blue 10px)", box);
    expect(result.reasons).toContain("gradient-repeating-flattened");
    expect(result.paint).not.toBeNull();
  });

  it("refuses conic gradients", () => {
    expect(parseGradient("conic-gradient(red, blue)", box)).toEqual({
      paint: null,
      reasons: ["gradient-conic-unsupported"],
    });
  });

  it("refuses a gradient with a single stop", () => {
    const result = parseGradient("linear-gradient(red)", box);
    expect(result.paint).toBeNull();
    expect(result.reasons).toContain("gradient-too-few-stops");
  });
});

describe("parseGradient — radial", () => {
  it("parses the form getComputedStyle emits", () => {
    const result = parseGradient(
      "radial-gradient(circle at 50% 50%, rgb(255, 0, 0) 0%, rgb(0, 0, 255) 100%)",
      square,
    );
    expect(result.paint).toMatchObject({
      kind: "radial-gradient",
      shape: "circle",
      center: { x: 0.5, y: 0.5 },
    });
  });

  it("defaults to a farthest-corner ellipse centred in the box", () => {
    const result = parseGradient("radial-gradient(red, blue)", box);
    expect(result.paint).toMatchObject({
      kind: "radial-gradient",
      shape: "ellipse",
      center: { x: 0.5, y: 0.5 },
    });
  });

  it("resolves closest-side against the centre position", () => {
    const result = parseGradient("radial-gradient(closest-side at 25% 50%, red, blue)", box);
    if (result.paint?.kind !== "radial-gradient") throw new Error("expected a radial gradient");
    // Centre at x=50 of a 200px box: nearest vertical edge is 50px away.
    expect(result.paint.radius.x).toBeCloseTo(50 / 200, 4);
    expect(result.paint.radius.y).toBeCloseTo(50 / 100, 4);
  });

  it("honours explicit radii", () => {
    const result = parseGradient("radial-gradient(100px 25px at 10px 20px, red, blue)", box);
    if (result.paint?.kind !== "radial-gradient") throw new Error("expected a radial gradient");
    expect(result.paint.radius).toEqual({ x: 0.5, y: 0.25 });
    expect(result.paint.center).toEqual({ x: 0.05, y: 0.2 });
  });

  it("computes a circle's farthest-corner radius", () => {
    const result = parseGradient("radial-gradient(circle at 0% 0%, red, blue)", square);
    if (result.paint?.kind !== "radial-gradient") throw new Error("expected a radial gradient");
    // From the top-left corner of a 100x100 box, the farthest corner is √2·100.
    expect(result.paint.radius.x).toBeCloseTo(Math.SQRT2, 3);
  });
});

describe("normaliseStops", () => {
  it("anchors the first and last stop", () => {
    expect(
      normaliseStops([
        { color: red, offset: null },
        { color: blue, offset: null },
      ]),
    ).toEqual([
      { color: red, offset: 0 },
      { color: blue, offset: 1 },
    ]);
  });

  it("distributes unpositioned stops evenly", () => {
    const stops = normaliseStops([
      { color: red, offset: 0 },
      { color: blue, offset: null },
      { color: red, offset: null },
      { color: blue, offset: 1 },
    ]);
    expect(stops.map((stop) => stop.offset)).toEqual([0, 0.3333, 0.6667, 1]);
  });

  it("clamps decreasing positions to the running maximum", () => {
    const stops = normaliseStops([
      { color: red, offset: 0.5 },
      { color: blue, offset: 0.2 },
      { color: red, offset: 0.9 },
    ]);
    expect(stops.map((stop) => stop.offset)).toEqual([0.5, 0.5, 0.9]);
  });
});

describe("linearGradientLineLength", () => {
  it("matches the box side for the axis-aligned angles", () => {
    expect(linearGradientLineLength(0, box)).toBeCloseTo(100);
    expect(linearGradientLineLength(90, box)).toBeCloseTo(200);
    expect(linearGradientLineLength(180, box)).toBeCloseTo(100);
  });
});

describe("isGradient", () => {
  it("recognises every gradient function", () => {
    expect(isGradient("linear-gradient(red, blue)")).toBe(true);
    expect(isGradient("repeating-radial-gradient(red, blue)")).toBe(true);
    expect(isGradient("url(a.png)")).toBe(false);
    expect(isGradient("none")).toBe(false);
  });
});
