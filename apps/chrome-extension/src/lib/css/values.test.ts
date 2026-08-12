import { describe, expect, it } from "vitest";
import {
  parseAngle,
  parseFunction,
  parseLength,
  parseLengthOrPercentage,
  parseNumber,
  parsePercentage,
  round,
  splitTopLevel,
  splitTopLevelWhitespace,
  stripQuotes,
} from "./values.ts";

describe("splitTopLevel", () => {
  it("ignores separators nested inside functions", () => {
    expect(splitTopLevel("linear-gradient(rgb(1, 2, 3), rgb(4, 5, 6))")).toEqual([
      "linear-gradient(rgb(1, 2, 3), rgb(4, 5, 6))",
    ]);
    expect(splitTopLevel("rgb(1, 2, 3), rgb(4, 5, 6)")).toEqual(["rgb(1, 2, 3)", "rgb(4, 5, 6)"]);
  });

  it("ignores separators inside quotes", () => {
    expect(splitTopLevel(`"Helvetica, Neue", Arial`)).toEqual([`"Helvetica, Neue"`, "Arial"]);
  });

  it("drops empty segments", () => {
    expect(splitTopLevel("a,,b")).toEqual(["a", "b"]);
  });
});

describe("splitTopLevelWhitespace", () => {
  it("keeps function arguments together", () => {
    expect(splitTopLevelWhitespace("rgb(1, 2, 3) 0px 4px")).toEqual(["rgb(1, 2, 3)", "0px", "4px"]);
  });

  it("handles the modern slash syntax as one token", () => {
    expect(splitTopLevelWhitespace("rgb(1 2 3 / 50%) inset")).toEqual([
      "rgb(1 2 3 / 50%)",
      "inset",
    ]);
  });
});

describe("parseFunction", () => {
  it("splits name and arguments", () => {
    expect(parseFunction("url(  a/b.png )")).toEqual({ name: "url", args: "  a/b.png " });
  });

  it("rejects non-functions", () => {
    expect(parseFunction("12px")).toBeNull();
    expect(parseFunction("(nope)")).toBeNull();
  });
});

describe("parseLength", () => {
  it("parses px and zero", () => {
    expect(parseLength("12px")).toBe(12);
    expect(parseLength("-4.5px")).toBe(-4.5);
    expect(parseLength("0")).toBe(0);
  });

  it("converts the absolute units", () => {
    expect(parseLength("1in")).toBe(96);
    expect(parseLength("72pt")).toBe(96);
    expect(parseLength("1pc")).toBe(16);
    expect(round(parseLength("2.54cm") ?? 0)).toBe(96);
  });

  it("refuses relative units it cannot resolve", () => {
    expect(parseLength("2em")).toBeNull();
    expect(parseLength("50vw")).toBeNull();
    expect(parseLength("50%")).toBeNull();
  });
});

describe("parseLengthOrPercentage", () => {
  it("resolves percentages against the basis", () => {
    expect(parseLengthOrPercentage("50%", 200)).toBe(100);
    expect(parseLengthOrPercentage("10px", 200)).toBe(10);
    expect(parseLengthOrPercentage("auto", 200)).toBeNull();
  });
});

describe("parseAngle", () => {
  it("converts every angle unit to degrees", () => {
    expect(parseAngle("90deg")).toBe(90);
    expect(parseAngle("0.25turn")).toBe(90);
    expect(parseAngle("100grad")).toBe(90);
    expect(round(parseAngle("1.5707963rad") ?? 0, 4)).toBe(90);
    expect(parseAngle("45")).toBe(45);
  });
});

describe("misc helpers", () => {
  it("parses numbers and percentages", () => {
    expect(parseNumber("1.5e2")).toBe(150);
    expect(parseNumber("12px")).toBeNull();
    expect(parsePercentage("25%")).toBe(0.25);
    expect(parsePercentage("25")).toBeNull();
  });

  it("strips matching quotes only", () => {
    expect(stripQuotes(`"Inter"`)).toBe("Inter");
    expect(stripQuotes(`'Inter'`)).toBe("Inter");
    expect(stripQuotes(`Inter"`)).toBe(`Inter"`);
  });

  it("rounds without producing -0", () => {
    expect(round(-0.0001)).toBe(0);
    expect(Object.is(round(-0.0001), -0)).toBe(false);
    expect(round(1.23456, 2)).toBe(1.23);
  });
});
