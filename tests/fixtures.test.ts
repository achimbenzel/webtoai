import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { sceneStats, validateScene } from "@web2ai/schema";
import type { Scene, SceneNode } from "@web2ai/schema";

/**
 * Fixture tests.
 *
 * `scripts/capture-fixtures.mjs` runs the real walker against real Chromium
 * layout and commits the result. These tests then check those committed scenes
 * without needing a browser, which keeps `pnpm test` fast and CI simple. If a
 * parser or the paint-order resolver changes behaviour, regenerating the
 * fixtures shows exactly what moved.
 */

const fixturesDir = fileURLToPath(new URL("../fixtures", import.meta.url));

function fixtureNames(): string[] {
  return readdirSync(fixturesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => existsSync(join(fixturesDir, name, "expected-scene.json")))
    .sort();
}

function loadScene(name: string): Scene {
  const raw = readFileSync(join(fixturesDir, name, "expected-scene.json"), "utf8");
  return JSON.parse(raw) as Scene;
}

function flatten(node: SceneNode): SceneNode[] {
  return [node, ...node.children.flatMap(flatten)];
}

/** Node names ordered by resolved paint order — back to front. */
function paintOrder(scene: Scene): string[] {
  return flatten(scene.root)
    .sort((a, b) => a.stackingOrder - b.stackingOrder)
    .map((node) => node.name);
}

function byName(scene: Scene, name: string): SceneNode | undefined {
  return flatten(scene.root).find((node) => node.name === name);
}

const names = fixtureNames();

describe("fixtures", () => {
  it("has fixtures to check", () => {
    expect(names).toEqual(["landing-page", "stacking", "typography"]);
  });

  it.each(names)("%s produces a schema-valid scene", (name) => {
    const result = validateScene(loadScene(name));
    expect(result.ok, result.ok ? "" : result.message).toBe(true);
  });

  it.each(names)("%s gives every node a unique id and paint index", (name) => {
    const nodes = flatten(loadScene(name).root);
    expect(new Set(nodes.map((node) => node.id)).size).toBe(nodes.length);
    expect(new Set(nodes.map((node) => node.stackingOrder)).size).toBe(nodes.length);
  });

  it.each(names)("%s orders every node's children back-to-front", (name) => {
    for (const node of flatten(loadScene(name).root)) {
      const orders = node.children.map((child) => child.stackingOrder);
      expect(orders).toEqual([...orders].sort((a, b) => a - b));
    }
  });
});

describe("fixture: stacking", () => {
  const scene = loadScene("stacking");

  it("resolves the full paint order, not document order", () => {
    expect(paintOrder(scene)).toEqual([
      "body",
      // z-index: -1 paints behind its own parent's background.
      "div.box.behind",
      "div.stage",
      "div.flow",
      "div.box.auto-positioned",
      "div.trap",
      "div.trap__inner",
      "div.passthrough",
      "div.flow-stage",
      // Block, then float, then inline — CSS 2.1 Appendix E steps 4, 5, 7.
      "p",
      "div.floated",
      "span.inline-el",
      "div.box.z2",
      "div.box.z10",
      // Escapes its positioned-but-context-less wrapper, above everything.
      "div.passthrough__escapee",
    ]);
  });

  it("traps a z-index: 999 child inside an opacity wrapper", () => {
    const trap = byName(scene, "div.trap");
    const inner = byName(scene, "div.trap__inner");
    const z10 = byName(scene, "div.box.z10");
    expect(inner?.stackingOrder).toBeGreaterThan(trap?.stackingOrder ?? -1);
    expect(inner?.stackingOrder).toBeLessThan(z10?.stackingOrder ?? -1);
  });

  it("keeps the DOM hierarchy in the tree even where paint order crosses it", () => {
    // `.behind` paints before its parent but stays its child, so the layer
    // palette still mirrors the document. See docs/LIMITATIONS.md.
    const stage = byName(scene, "div.stage");
    const behind = stage?.children.find((child) => child.name === "div.box.behind");
    expect(behind).toBeDefined();
    expect(behind?.stackingOrder).toBeLessThan(stage?.stackingOrder ?? -1);
  });

  it("degrades nothing on a page of plain boxes", () => {
    expect(sceneStats(scene).unsupportedCount).toBe(0);
  });
});

describe("fixture: landing-page", () => {
  const scene = loadScene("landing-page");

  it("places the sticky header above the content that scrolls under it", () => {
    const header = byName(scene, "header.topbar");
    expect(header?.cssPosition).toBe("sticky");
    const hero = byName(scene, "section.hero");
    expect(header?.stackingOrder).toBeGreaterThan(hero?.stackingOrder ?? -1);
  });

  it("reads the hero's linear gradient with its real angle and stops", () => {
    const hero = byName(scene, "section.hero");
    expect(hero?.paint.fill).toMatchObject({ kind: "linear-gradient", angle: 135 });
    if (hero?.paint.fill?.kind !== "linear-gradient") throw new Error("expected a gradient");
    expect(hero.paint.fill.stops.map((stop) => stop.offset)).toEqual([0, 0.55, 1]);
  });

  it("reads a radial gradient on the decorative blob", () => {
    expect(byName(scene, "div.hero__blob")?.paint.fill).toMatchObject({
      kind: "radial-gradient",
      shape: "circle",
    });
  });

  it("keeps card radii, borders and shadows", () => {
    const card = byName(scene, "article.card.card--featured");
    expect(card?.paint.radius).toEqual([12, 12, 12, 12]);
    expect(card?.paint.shadows).toHaveLength(1);
    // The featured card has a heavier top border than its other sides.
    expect(card?.paint.stroke?.widths[0]).toBe(4);
    expect(card?.unsupportedReasons).toContain("border-widths-differ");
  });

  it("lifts the badge above its card via z-index", () => {
    const badge = byName(scene, "span.card__badge");
    const card = byName(scene, "article.card.card--featured");
    expect(badge?.stackingOrder).toBeGreaterThan(card?.stackingOrder ?? -1);
  });

  it("collects the inline SVG icons and the embedded raster", () => {
    const svgAssets = scene.assets.filter((asset) => asset.kind === "svg");
    expect(svgAssets).toHaveLength(3);
    expect(svgAssets[0]?.svg).toContain("<svg");
    expect(scene.assets.some((asset) => asset.src?.startsWith("data:image/svg+xml"))).toBe(true);
  });

  it("folds the footer's ::before into the footer's own text runs", () => {
    // A pseudo-element on a text element renders inline with the text, so it
    // becomes a leading run rather than a second, overlapping text frame.
    const footer = byName(scene, "footer.footer");
    expect(footer?.role).toBe("text");
    expect(footer?.text?.runs[0]?.chars).toBe("— ");
    expect(footer?.text?.runs[1]?.chars).toBe("Northwind Ltd. All rights reserved.");
    expect(footer?.unsupportedReasons).toContain("pseudo-element-merged-into-text");
  });

  it("records the fonts it saw", () => {
    expect(scene.fonts.map((font) => `${font.family}@${font.weight}`)).toContain("Arial@700");
  });
});

describe("fixture: typography", () => {
  const scene = loadScene("typography");

  it("marks a display heading as single-line and a paragraph as multi-line", () => {
    expect(byName(scene, "h1.single-line")?.text?.isSingleLine).toBe(true);
    expect(byName(scene, "p.paragraph")?.text?.isSingleLine).toBe(false);
  });

  it("splits a paragraph with inline markup into separate runs", () => {
    const runs = byName(scene, "p.paragraph")?.text?.runs ?? [];
    expect(runs.length).toBeGreaterThan(4);
    expect(runs.some((run) => run.font.weight === 700 && run.chars === "bold")).toBe(true);
    expect(runs.some((run) => run.font.style === "italic" && run.chars === "italic")).toBe(true);
    expect(runs.some((run) => run.decoration === "underline")).toBe(true);
  });

  it("preserves whitespace inside <pre>", () => {
    const chars = byName(scene, "pre.preformatted")?.text?.runs[0]?.chars ?? "";
    expect(chars).toContain("  indented    text");
    expect(byName(scene, "pre.preformatted")?.unsupportedReasons).toContain(
      "text-preformatted-whitespace-preserved",
    );
  });

  it("applies text-transform and letter-spacing", () => {
    const run = byName(scene, "p.shouty")?.text?.runs[0];
    expect(run?.chars).toBe("TRACKED OUT AND UPPERCASED BY CSS");
    expect(run?.letterSpacing).toBeCloseTo(1.68, 2);
  });

  it("scales a 9999px radius down into a real pill", () => {
    const pill = byName(scene, "div.swatch.swatch--pill");
    expect(pill?.paint.radius).toEqual([40, 40, 40, 40]);
    expect(pill?.unsupportedReasons).toContain("radius-scaled-to-fit");
  });

  it("keeps mixed corner radii distinct", () => {
    expect(byName(scene, "div.swatch.swatch--mixed")?.paint.radius).toEqual([24, 4, 24, 4]);
  });

  it("reports an elliptical corner instead of silently rounding it", () => {
    const elliptical = byName(scene, "div.swatch.swatch--elliptical");
    expect(elliptical?.unsupportedReasons).toContain("radius-elliptical-approximated");
  });

  it("reports four differing borders for the four-path renderer", () => {
    const bordered = byName(scene, "div.swatch.swatch--bordered");
    expect(bordered?.paint.stroke?.widths).toEqual([6, 2, 6, 2]);
    expect(bordered?.paint.stroke?.colors).toHaveLength(4);
    expect(bordered?.paint.stroke?.styles).toEqual(["solid", "dashed", "solid", "dashed"]);
  });

  it("keeps both shadows and flags the multiple", () => {
    const shadowed = byName(scene, "div.shadowed");
    expect(shadowed?.paint.shadows).toHaveLength(2);
    expect(shadowed?.unsupportedReasons).toContain("shadow-multiple");
  });

  it("carries a rotation as metadata and reports the lost geometry", () => {
    const rotated = byName(scene, "div.rotated");
    expect(rotated?.transform).toHaveLength(6);
    expect(rotated?.unsupportedReasons).toContain("transform-baked-into-bounds");
  });
});
