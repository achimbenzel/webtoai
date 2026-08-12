/**
 * Resolved CSS paint order.
 *
 * This is what makes the Illustrator layer order match what the browser draws.
 * DOM order is *not* paint order: a `z-index: -1` background paints behind its
 * parent's content, a positioned element paints above later siblings, and an
 * `opacity: 0.99` wrapper silently promotes its whole subtree into its own
 * stacking context.
 *
 * The implementation follows CSS 2.1 Appendix E, extended with the modern
 * stacking-context triggers. It works on plain style records rather than DOM
 * nodes, so it is fully unit-testable without a browser.
 */

/** The computed style values that decide paint order, per element. */
export interface StackingInput {
  id: string;
  display: string;
  position: string;
  zIndex: string;
  opacity: string;
  transform: string;
  filter: string;
  backdropFilter: string;
  mixBlendMode: string;
  isolation: string;
  willChange: string;
  contain: string;
  clipPath: string;
  mask: string;
  perspective: string;
  float: string;
  /** `display` of the parent element; flex/grid items honour z-index. */
  parentDisplay: string;
  children: StackingInput[];
}

/** Everything a caller needs to build a `StackingInput` with sane defaults. */
export function stackingDefaults(): Omit<StackingInput, "id" | "children"> {
  return {
    display: "block",
    position: "static",
    zIndex: "auto",
    opacity: "1",
    transform: "none",
    filter: "none",
    backdropFilter: "none",
    mixBlendMode: "normal",
    isolation: "auto",
    willChange: "auto",
    contain: "none",
    clipPath: "none",
    mask: "none",
    perspective: "none",
    float: "none",
    parentDisplay: "block",
  };
}

function isNone(value: string): boolean {
  const normalised = value.trim().toLowerCase();
  return normalised === "" || normalised === "none" || normalised === "normal";
}

export function isPositioned(input: StackingInput): boolean {
  const position = input.position.trim().toLowerCase();
  return (
    position === "relative" ||
    position === "absolute" ||
    position === "fixed" ||
    position === "sticky"
  );
}

function isFlexOrGridItem(input: StackingInput): boolean {
  return /\b(flex|grid|inline-flex|inline-grid)\b/.test(input.parentDisplay.toLowerCase());
}

/**
 * Whether the element establishes a stacking context.
 *
 * Missing a trigger here is the expensive failure mode: the subtree then gets
 * interleaved with its siblings instead of being painted atomically.
 */
export function createsStackingContext(input: StackingInput): boolean {
  const position = input.position.trim().toLowerCase();
  const zIndex = input.zIndex.trim().toLowerCase();

  // Positioned with an explicit z-index.
  if (isPositioned(input) && zIndex !== "auto") return true;
  // Flex and grid items honour z-index even when they are not positioned.
  if (isFlexOrGridItem(input) && zIndex !== "auto") return true;
  // fixed and sticky always establish one, z-index or not.
  if (position === "fixed" || position === "sticky") return true;

  const opacity = Number(input.opacity);
  if (Number.isFinite(opacity) && opacity < 1) return true;

  if (!isNone(input.transform)) return true;
  if (!isNone(input.filter)) return true;
  if (!isNone(input.backdropFilter)) return true;
  if (!isNone(input.clipPath)) return true;
  if (!isNone(input.mask)) return true;
  if (!isNone(input.perspective)) return true;
  if (!isNone(input.mixBlendMode)) return true;
  if (input.isolation.trim().toLowerCase() === "isolate") return true;

  const willChange = input.willChange.toLowerCase();
  if (
    /\b(transform|opacity|filter|perspective|mix-blend-mode|isolation|z-index)\b/.test(willChange)
  ) {
    return true;
  }

  const contain = input.contain.toLowerCase();
  if (/\b(paint|layout|strict|content)\b/.test(contain)) return true;

  return false;
}

/** `z-index` as a number; `auto` and unparsable values count as 0. */
export function resolvedZIndex(input: StackingInput): number {
  const value = Number(input.zIndex.trim());
  return Number.isFinite(value) ? value : 0;
}

function isFloating(input: StackingInput): boolean {
  const float = input.float.trim().toLowerCase();
  return float === "left" || float === "right";
}

function isInlineLevel(input: StackingInput): boolean {
  const display = input.display.trim().toLowerCase();
  return display.startsWith("inline") || display === "contents";
}

/** CSS 2.1 Appendix E paint steps, as bucket indices. */
const BUCKET = {
  NEGATIVE: 0,
  BLOCK: 1,
  FLOAT: 2,
  INLINE: 3,
  ZERO: 4,
  POSITIVE: 5,
} as const;

interface Buckets {
  negative: Array<{ node: StackingInput; z: number }>;
  block: StackingInput[];
  float: StackingInput[];
  inline: StackingInput[];
  zero: StackingInput[];
  positive: Array<{ node: StackingInput; z: number }>;
}

function emptyBuckets(): Buckets {
  return { negative: [], block: [], float: [], inline: [], zero: [], positive: [] };
}

/**
 * Distributes a subtree into paint buckets.
 *
 * Two destinations, and the split is the whole subtlety of Appendix E step 8:
 *
 *  - `own` receives in-flow descendants, which paint together with `node`.
 *  - `hoist` receives stacking contexts and positioned descendants, which
 *    belong to the nearest *real* ancestor stacking context.
 *
 * For a real stacking context the two are the same object. For a positioned
 * element with `z-index: auto` — which paints atomically like a context but is
 * not one — they differ: its own text and boxes stay with it, while a
 * `z-index: 999` descendant escapes past it, exactly as CSS specifies. Getting
 * this wrong is what makes a dropdown menu render underneath the content it is
 * supposed to cover.
 *
 * Pseudo-contexts are descended into immediately so that everything lands in
 * `hoist` in document order.
 */
function gather(
  node: StackingInput,
  own: Buckets,
  hoist: Buckets,
  inflowOf: Map<string, StackingInput[]>,
): void {
  for (const child of node.children) {
    if (createsStackingContext(child)) {
      const z = resolvedZIndex(child);
      if (z < 0) hoist.negative.push({ node: child, z });
      else if (z > 0) hoist.positive.push({ node: child, z });
      else hoist.zero.push(child);
      // A real context is atomic: paintContext recurses into it later.
      continue;
    }

    if (isPositioned(child)) {
      hoist.zero.push(child);
      const childOwn = emptyBuckets();
      gather(child, childOwn, hoist, inflowOf);
      inflowOf.set(child.id, [...childOwn.block, ...childOwn.float, ...childOwn.inline]);
      continue;
    }

    if (isFloating(child)) own.float.push(child);
    else if (isInlineLevel(child)) own.inline.push(child);
    else own.block.push(child);

    gather(child, own, hoist, inflowOf);
  }
}

/** Stable ascending sort by z-index (Array.prototype.sort is stable in ES2019+). */
function byZIndex(entries: Array<{ node: StackingInput; z: number }>): StackingInput[] {
  return [...entries].sort((a, b) => a.z - b.z).map((entry) => entry.node);
}

function paintContext(root: StackingInput, out: string[]): void {
  // Step 1: the context root's own background and borders.
  out.push(root.id);

  const buckets = emptyBuckets();
  const inflowOf = new Map<string, StackingInput[]>();
  gather(root, buckets, buckets, inflowOf);

  for (const node of byZIndex(buckets.negative)) paintContext(node, out);
  for (const node of buckets.block) out.push(node.id);
  for (const node of buckets.float) out.push(node.id);
  for (const node of buckets.inline) out.push(node.id);

  // Step 8: positioned descendants with z-index auto/0, in tree order. A real
  // stacking context recurses; a pseudo-context paints its own in-flow content.
  for (const node of buckets.zero) {
    if (createsStackingContext(node)) {
      paintContext(node, out);
      continue;
    }
    out.push(node.id);
    for (const child of inflowOf.get(node.id) ?? []) out.push(child.id);
  }

  for (const node of byZIndex(buckets.positive)) paintContext(node, out);
}

/**
 * Returns every id in the tree in resolved paint order: index 0 is painted
 * first (furthest back), the last index is painted last (frontmost).
 */
export function resolvePaintOrder(root: StackingInput): string[] {
  const order: string[] = [];
  paintContext(root, order);
  return order;
}

/** `id -> paint index`, which is what `SceneNode.stackingOrder` carries. */
export function paintOrderIndex(root: StackingInput): Map<string, number> {
  const index = new Map<string, number>();
  resolvePaintOrder(root).forEach((id, position) => index.set(id, position));
  return index;
}

/** Exported for tests: which Appendix E step an element is painted in. */
export function paintBucket(child: StackingInput): number {
  if (createsStackingContext(child)) {
    const z = resolvedZIndex(child);
    if (z < 0) return BUCKET.NEGATIVE;
    if (z > 0) return BUCKET.POSITIVE;
    return BUCKET.ZERO;
  }
  if (isPositioned(child)) return BUCKET.ZERO;
  if (isFloating(child)) return BUCKET.FLOAT;
  if (isInlineLevel(child)) return BUCKET.INLINE;
  return BUCKET.BLOCK;
}

export { BUCKET };
