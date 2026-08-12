import { describe, expect, it } from "vitest";
import {
  createsStackingContext,
  isPositioned,
  paintOrderIndex,
  resolvePaintOrder,
  stackingDefaults,
  type StackingInput,
} from "./stacking.ts";

function node(
  id: string,
  overrides: Partial<Omit<StackingInput, "id" | "children">> = {},
  children: StackingInput[] = [],
): StackingInput {
  return { ...stackingDefaults(), ...overrides, id, children };
}

describe("createsStackingContext", () => {
  it("is false for a plain block", () => {
    expect(createsStackingContext(node("a"))).toBe(false);
  });

  it("is true for a positioned element with an explicit z-index", () => {
    expect(createsStackingContext(node("a", { position: "relative", zIndex: "1" }))).toBe(true);
    expect(createsStackingContext(node("a", { position: "relative", zIndex: "auto" }))).toBe(false);
    // z-index alone, without positioning, does nothing.
    expect(createsStackingContext(node("a", { zIndex: "5" }))).toBe(false);
  });

  it("is true for fixed and sticky regardless of z-index", () => {
    expect(createsStackingContext(node("a", { position: "fixed" }))).toBe(true);
    expect(createsStackingContext(node("a", { position: "sticky" }))).toBe(true);
  });

  it("catches the non-obvious triggers", () => {
    expect(createsStackingContext(node("a", { opacity: "0.99" }))).toBe(true);
    expect(createsStackingContext(node("a", { transform: "matrix(1, 0, 0, 1, 1, 0)" }))).toBe(true);
    expect(createsStackingContext(node("a", { filter: "blur(2px)" }))).toBe(true);
    expect(createsStackingContext(node("a", { backdropFilter: "blur(2px)" }))).toBe(true);
    expect(createsStackingContext(node("a", { mixBlendMode: "multiply" }))).toBe(true);
    expect(createsStackingContext(node("a", { isolation: "isolate" }))).toBe(true);
    expect(createsStackingContext(node("a", { willChange: "transform" }))).toBe(true);
    expect(createsStackingContext(node("a", { contain: "paint" }))).toBe(true);
    expect(createsStackingContext(node("a", { clipPath: "circle(50%)" }))).toBe(true);
    expect(createsStackingContext(node("a", { perspective: "500px" }))).toBe(true);
  });

  it("honours z-index on flex and grid items", () => {
    expect(createsStackingContext(node("a", { parentDisplay: "flex", zIndex: "2" }))).toBe(true);
    expect(createsStackingContext(node("a", { parentDisplay: "block", zIndex: "2" }))).toBe(false);
  });

  it("does not fire on will-change values that do not promote", () => {
    expect(createsStackingContext(node("a", { willChange: "scroll-position" }))).toBe(false);
  });
});

describe("isPositioned", () => {
  it("covers every non-static position", () => {
    expect(isPositioned(node("a", { position: "static" }))).toBe(false);
    for (const position of ["relative", "absolute", "fixed", "sticky"]) {
      expect(isPositioned(node("a", { position }))).toBe(true);
    }
  });
});

describe("resolvePaintOrder", () => {
  it("paints a plain tree in document order, parents before children", () => {
    const tree = node("root", {}, [node("a", {}, [node("a1")]), node("b")]);
    expect(resolvePaintOrder(tree)).toEqual(["root", "a", "a1", "b"]);
  });

  it("paints negative z-index behind the parent's content", () => {
    const tree = node("root", {}, [
      node("behind", { position: "absolute", zIndex: "-1" }),
      node("normal"),
    ]);
    // The root still paints first (its own background), then the negative
    // layer, then in-flow content.
    expect(resolvePaintOrder(tree)).toEqual(["root", "behind", "normal"]);
  });

  it("paints positioned elements above later in-flow siblings", () => {
    const tree = node("root", {}, [
      node("positioned", { position: "relative" }),
      node("later-block"),
    ]);
    // DOM order is positioned, later-block — paint order is the other way.
    expect(resolvePaintOrder(tree)).toEqual(["root", "later-block", "positioned"]);
  });

  it("orders positive z-index ascending, after everything else", () => {
    const tree = node("root", {}, [
      node("z10", { position: "absolute", zIndex: "10" }),
      node("z2", { position: "absolute", zIndex: "2" }),
      node("flow"),
    ]);
    expect(resolvePaintOrder(tree)).toEqual(["root", "flow", "z2", "z10"]);
  });

  it("keeps DOM order between equal z-indexes", () => {
    const tree = node("root", {}, [
      node("first", { position: "absolute", zIndex: "3" }),
      node("second", { position: "absolute", zIndex: "3" }),
    ]);
    expect(resolvePaintOrder(tree)).toEqual(["root", "first", "second"]);
  });

  it("paints floats after block backgrounds and before inline content", () => {
    const tree = node("root", {}, [
      node("inline-el", { display: "inline" }),
      node("floated", { float: "left" }),
      node("block-el"),
    ]);
    expect(resolvePaintOrder(tree)).toEqual(["root", "block-el", "floated", "inline-el"]);
  });

  it("hoists a deeply nested positioned element into its stacking context", () => {
    // This is the case DOM order gets wrong: `.overlay` is buried inside the
    // first sibling but CSS paints it above the second sibling entirely.
    const tree = node("root", {}, [
      node("card", {}, [node("card-body", {}, [node("overlay", { position: "absolute" })])]),
      node("next-card"),
    ]);
    expect(resolvePaintOrder(tree)).toEqual(["root", "card", "card-body", "next-card", "overlay"]);
  });

  it("keeps a stacking context's subtree atomic", () => {
    // `wrapper` has opacity < 1, so its z-index: 100 child cannot escape it.
    const tree = node("root", {}, [
      node("wrapper", { opacity: "0.5" }, [node("inner", { position: "absolute", zIndex: "100" })]),
      node("sibling", { position: "absolute", zIndex: "1" }),
    ]);
    expect(resolvePaintOrder(tree)).toEqual(["root", "wrapper", "inner", "sibling"]);
  });

  it("lets a z-index: 100 child escape a wrapper that is NOT a stacking context", () => {
    const tree = node("root", {}, [
      node("wrapper", {}, [node("inner", { position: "absolute", zIndex: "100" })]),
      node("sibling", { position: "absolute", zIndex: "1" }),
    ]);
    expect(resolvePaintOrder(tree)).toEqual(["root", "wrapper", "sibling", "inner"]);
  });

  it("lets it escape a positioned wrapper too — position alone is not a context", () => {
    // The dropdown case: `.menu` is position: relative with z-index auto, so it
    // establishes no context and the flyout inside it must paint above the
    // z-index: 10 element next to it.
    const tree = node("root", {}, [
      node("menu", { position: "relative" }, [
        node("flyout", { position: "absolute", zIndex: "999" }),
      ]),
      node("banner", { position: "absolute", zIndex: "10" }),
    ]);
    expect(resolvePaintOrder(tree)).toEqual(["root", "menu", "banner", "flyout"]);
  });

  it("keeps a pseudo-context's own in-flow content with it", () => {
    const tree = node("root", {}, [
      node("card", { position: "relative" }, [
        node("card-text"),
        node("card-pin", { position: "absolute", zIndex: "3" }),
      ]),
      node("after-card"),
    ]);
    // `card-text` paints with its parent, `card-pin` escapes to the root.
    expect(resolvePaintOrder(tree)).toEqual([
      "root",
      "after-card",
      "card",
      "card-text",
      "card-pin",
    ]);
  });

  it("keeps hoisted descendants in document order", () => {
    const tree = node("root", {}, [
      node("a", { position: "absolute" }, [node("a-inner", { position: "absolute" })]),
      node("b", { position: "absolute" }),
    ]);
    expect(resolvePaintOrder(tree)).toEqual(["root", "a", "a-inner", "b"]);
  });

  it("handles the sticky-header-over-content case", () => {
    const tree = node("root", {}, [
      node("header", { position: "sticky", zIndex: "50" }),
      node("main", {}, [node("hero"), node("copy")]),
    ]);
    expect(resolvePaintOrder(tree)).toEqual(["root", "main", "hero", "copy", "header"]);
  });

  it("combines negative, flow and positive layers in one pass", () => {
    const tree = node("root", {}, [
      node("pos5", { position: "absolute", zIndex: "5" }),
      node("neg1", { position: "absolute", zIndex: "-1" }),
      node("flow-a"),
      node("neg9", { position: "absolute", zIndex: "-9" }),
      node("auto-pos", { position: "absolute" }),
      node("flow-b"),
    ]);
    expect(resolvePaintOrder(tree)).toEqual([
      "root",
      "neg9",
      "neg1",
      "flow-a",
      "flow-b",
      "auto-pos",
      "pos5",
    ]);
  });
});

describe("paintOrderIndex", () => {
  it("maps every id to a unique ascending index", () => {
    const tree = node("root", {}, [node("a"), node("b", { position: "relative" })]);
    const index = paintOrderIndex(tree);
    expect(index.get("root")).toBe(0);
    expect(index.get("a")).toBe(1);
    expect(index.get("b")).toBe(2);
    expect(new Set(index.values()).size).toBe(index.size);
  });
});
