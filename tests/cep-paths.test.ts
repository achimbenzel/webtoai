import { describe, expect, it } from "vitest";
// @ts-expect-error — plain-JS tooling module, shared by the install/doctor scripts.
import { compareVersions, hostRangeAccepts } from "../scripts/cep-paths.mjs";

/**
 * The host-range check decides whether the doctor tells the user "your
 * Illustrator is outside the manifest range", which is one of the few CEP
 * failures with no other symptom at all. Worth getting right.
 */

const compare = compareVersions as (a: string, b: string) => number;
const accepts = hostRangeAccepts as (
  range: string | undefined,
  version: string | undefined,
) => boolean | undefined;

describe("compareVersions", () => {
  it("orders dotted versions numerically, not lexically", () => {
    expect(compare("9.0", "10.0")).toBe(-1);
    expect(compare("25.0", "9.0")).toBe(1);
    expect(compare("26.0", "26.0")).toBe(0);
  });

  it("treats missing components as zero", () => {
    expect(compare("25", "25.0")).toBe(0);
    expect(compare("25.0.1", "25.0")).toBe(1);
  });
});

describe("hostRangeAccepts", () => {
  it("accepts versions inside an inclusive range", () => {
    expect(accepts("[25.0,99.9]", "25.0")).toBe(true);
    expect(accepts("[25.0,99.9]", "29.4")).toBe(true);
    expect(accepts("[25.0,99.9]", "99.9")).toBe(true);
  });

  it("rejects versions below the range — the Illustrator-too-old case", () => {
    expect(accepts("[25.0,99.9]", "24.3")).toBe(false);
    expect(accepts("[25.0,99.9]", "16.0")).toBe(false);
  });

  it("honours exclusive bounds", () => {
    expect(accepts("(25.0,99.9)", "25.0")).toBe(false);
    expect(accepts("(25.0,99.9)", "25.1")).toBe(true);
  });

  it("treats a bare version as a minimum", () => {
    expect(accepts("25.0", "26.0")).toBe(true);
    expect(accepts("25.0", "24.0")).toBe(false);
  });

  it("returns undefined rather than guessing at input it cannot read", () => {
    expect(accepts(undefined, "26.0")).toBeUndefined();
    expect(accepts("[25.0,99.9]", undefined)).toBeUndefined();
    expect(accepts("all", "26.0")).toBeUndefined();
  });
});
