import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createContext, runInContext } from "node:vm";
import { beforeEach, describe, expect, it } from "vitest";
import {
  allItems,
  allLayers,
  createIllustratorSandbox,
  type FakeDocument,
} from "./fake-illustrator.ts";

/**
 * The renderer, run against a fake Illustrator.
 *
 * What is asserted here is the part that is pure structure and therefore the
 * part most likely to be silently wrong: the y-axis flip, z-order, layer
 * nesting and its depth limit, which item clips which, and that one broken
 * node cannot take the import down. None of that needs Illustrator to be true.
 */

const hostDir = fileURLToPath(new URL("../host", import.meta.url));
const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));

interface RenderBegin {
  total: number;
  width: number;
  height: number;
}
interface RenderStep {
  done: boolean;
  built: number;
  failed: number;
  total: number;
}
interface ReportRow {
  level: string;
  code: string;
  count: number;
  examples: string[];
}
interface ReportSummary {
  rows: ReportRow[];
  nodesTotal: number;
  nodesBuilt: number;
  nodesFailed: number;
  cancelled: boolean;
  fontSubstitutions: Array<{ requested: string; used: string; count: number }>;
}

interface Host {
  setExtensionRoot(path: string): string;
  loadSceneFile(path: string): unknown;
  renderBegin(): RenderBegin;
  renderStep(batch: number): RenderStep;
  renderFinish(cancelled: boolean): ReportSummary;
  reportMarkdown(report: unknown, scene: unknown): string;
  frameToArtboard(
    frame: { x: number; y: number; w: number; h: number },
    scale: number,
  ): { top: number; left: number; width: number; height: number };
  clampRadii(radius: number[], w: number, h: number): number[];
  roundedRectPoints(box: unknown, radius: number[]): unknown[];
  borderStrips(box: unknown, widths: number[]): Array<{ side: string; height: number }>;
  gradientAngle(css: number): number;
  shadowOffsets(shadow: unknown, scale: number): { shiftX: number; shiftY: number; blur: number };
  normaliseGradientStops(stops: unknown[]): Array<{ rampPoint: number }>;
  effectiveOpacity(alpha: number, opacity: number): number;
  base64Decode(input: string): string;
  parseDataUrl(url: string): { mime: string; base64: boolean; data: string } | null;
  blendModeKey(mode: string): string | null;
  isVectorAsset(asset: { kind: string; mime: string }, mime: string): boolean;
  fitImage(
    box: { top: number; left: number; width: number; height: number },
    natural: { width: number; height: number },
    fit: string,
    position: { x: number; y: number } | null,
  ): { top: number; left: number; width: number; height: number; overflows: boolean };
  weightOfStyleName(style: string): number;
  isItalicStyleName(style: string): boolean;
  normaliseFamily(family: string): string;
  familyStack(font: { family: string; stack?: string }): string[];
  resolveFont(font: {
    family: string;
    weight: number;
    style: string;
    isWebFont?: boolean;
    stack?: string;
  }): { font: { name: string } | null; requested: string; used: string; substituted: boolean };
  _lastReport: unknown;
  _lastReportScene: unknown;
}

function hostBundle(): string {
  const sources = readdirSync(hostDir)
    .filter((name) => name.endsWith(".jsx"))
    .sort();
  return [
    readFileSync(join(hostDir, "lib", "json2.js"), "utf8"),
    ...sources.map((name) => readFileSync(join(hostDir, name), "utf8")),
  ].join("\n\n");
}

let files: Record<string, string>;
let illustrator: ReturnType<typeof createIllustratorSandbox>;
let host: Host;

function boot(): void {
  files = {};
  files["/ext/config/web2ai.config.json"] = readFileSync(
    join(repoRoot, "config", "web2ai.config.json"),
    "utf8",
  );
  files["/ext/config/font-map.json"] = readFileSync(
    join(repoRoot, "config", "font-map.json"),
    "utf8",
  );

  illustrator = createIllustratorSandbox(files);
  createContext(illustrator.sandbox);
  runInContext(hostBundle(), illustrator.sandbox);
  host = illustrator.sandbox["web2ai"] as Host;
  host.setExtensionRoot("/ext");
}

/** Runs a whole render and returns the document plus the report. */
function render(scene: unknown): { doc: FakeDocument; report: ReportSummary } {
  files["/scene.json"] = JSON.stringify(scene);
  host.loadSceneFile("/scene.json");
  host.renderBegin();

  let guard = 0;
  let step: RenderStep;
  do {
    step = host.renderStep(50);
    guard += 1;
    if (guard > 500) throw new Error("render did not terminate");
  } while (!step.done);

  const report = host.renderFinish(false);
  const doc = illustrator.document();
  if (doc === undefined) throw new Error("no document was created");
  return { doc, report };
}

function scene(root: unknown, overrides: Record<string, unknown> = {}): unknown {
  return {
    version: 1,
    source: {
      url: "https://example.test/",
      title: "Example",
      capturedAt: "2026-01-01T00:00:00.000Z",
      viewport: { w: 800, h: 600, dpr: 1 },
      document: { w: 800, h: 600 },
    },
    options: { textAsOutlines: false },
    fonts: [],
    assets: [],
    root,
    ...overrides,
  };
}

function node(partial: Record<string, unknown>): Record<string, unknown> {
  return {
    id: String(partial["id"] ?? "n1"),
    name: String(partial["name"] ?? "div"),
    role: "box",
    frame: { x: 0, y: 0, w: 100, h: 50 },
    paint: { radius: [0, 0, 0, 0], opacity: 1 },
    clip: false,
    stackingOrder: 0,
    children: [],
    ...partial,
  };
}

const solid = (r: number, g: number, b: number, a = 1) => ({
  kind: "solid",
  color: { r, g, b, a },
});

beforeEach(boot);

describe("geometry", () => {
  it("flips the y axis and leaves x alone", () => {
    // The single most consequential line in the renderer: get it wrong and the
    // entire document sits below the artboard.
    expect(host.frameToArtboard({ x: 10, y: 20, w: 100, h: 50 }, 1)).toEqual({
      top: -20,
      left: 10,
      width: 100,
      height: 50,
    });
  });

  it("scales by points per CSS pixel", () => {
    expect(host.frameToArtboard({ x: 10, y: 20, w: 100, h: 50 }, 0.75)).toEqual({
      top: -15,
      left: 7.5,
      width: 75,
      height: 37.5,
    });
  });

  it("clamps radii that would overlap, the way CSS does", () => {
    expect(host.clampRadii([50, 50, 50, 50], 100, 100)).toEqual([50, 50, 50, 50]);
    expect(host.clampRadii([100, 100, 0, 0], 100, 100)).toEqual([50, 50, 0, 0]);
    expect(host.clampRadii([-5, 0, 0, 0], 100, 100)).toEqual([0, 0, 0, 0]);
  });

  it("emits eight points for four rounded corners and four for none", () => {
    const box = { top: 0, left: 0, width: 100, height: 100 };
    expect(host.roundedRectPoints(box, [10, 10, 10, 10])).toHaveLength(8);
    expect(host.roundedRectPoints(box, [0, 0, 0, 0])).toHaveLength(4);
    // Two rounded corners contribute two points each, two square ones one each.
    expect(host.roundedRectPoints(box, [10, 0, 10, 0])).toHaveLength(6);
  });

  it("splits unequal borders into strips that do not overlap at the corners", () => {
    const box = { top: 0, left: 0, width: 100, height: 100 };
    const strips = host.borderStrips(box, [10, 5, 10, 5]);
    expect(strips.map((s) => s.side).sort()).toEqual(["bottom", "left", "right", "top"]);
    // The vertical strips run between the horizontals, so corners paint once.
    const left = strips.find((s) => s.side === "left");
    expect(left?.height).toBe(80);
  });

  it("omits sides with no width", () => {
    const strips = host.borderStrips({ top: 0, left: 0, width: 100, height: 100 }, [4, 0, 0, 0]);
    expect(strips).toHaveLength(1);
    expect(strips[0]?.side).toBe("top");
  });

  it("converts CSS gradient angles to Illustrator's", () => {
    // CSS: 0 is up, 90 is right. Illustrator: 0 is right, 90 is up.
    expect(host.gradientAngle(0)).toBe(90);
    expect(host.gradientAngle(90)).toBe(0);
    expect(host.gradientAngle(180)).toBe(-90);
    expect(host.gradientAngle(270)).toBe(180);
  });

  it("flips a shadow's vertical offset with everything else", () => {
    expect(host.shadowOffsets({ offsetX: 2, offsetY: 4, blur: 8 }, 1)).toEqual({
      shiftX: 2,
      shiftY: -4,
      blur: 8,
    });
  });
});

describe("paint helpers", () => {
  it("keeps gradient ramp points strictly ascending", () => {
    // Illustrator rejects a gradient whose stops share a ramp point, which CSS
    // uses routinely for a hard colour break.
    const stops = host.normaliseGradientStops([
      { color: { r: 0, g: 0, b: 0, a: 1 }, offset: 0.5 },
      { color: { r: 255, g: 255, b: 255, a: 1 }, offset: 0.5 },
    ]);
    expect(stops[0]?.rampPoint).toBe(50);
    expect(stops[1]?.rampPoint).toBeGreaterThan(50);
  });

  it("expands a single stop into a usable gradient", () => {
    expect(
      host.normaliseGradientStops([{ color: { r: 1, g: 2, b: 3, a: 1 }, offset: 0 }]),
    ).toHaveLength(2);
  });

  it("multiplies colour alpha into object opacity", () => {
    // Illustrator has no per-colour alpha, so the two have to combine.
    expect(host.effectiveOpacity(0.5, 0.5)).toBe(25);
    expect(host.effectiveOpacity(1, 1)).toBe(100);
  });

  it("refuses blend modes Illustrator has no equivalent for", () => {
    expect(host.blendModeKey("multiply")).toBe("MULTIPLY");
    expect(host.blendModeKey("plus-lighter")).toBeNull();
  });
});

describe("assets", () => {
  it("decodes base64", () => {
    expect(host.base64Decode("aGVsbG8=")).toBe("hello");
    expect(host.base64Decode("YQ==")).toBe("a");
    expect(host.base64Decode("")).toBe("");
  });

  it("decodes a payload larger than its internal block size", () => {
    const text = "web2ai".repeat(2000);
    const encoded = Buffer.from(text, "binary").toString("base64");
    expect(host.base64Decode(encoded)).toBe(text);
  });

  it("splits a data URL into mime and payload", () => {
    expect(host.parseDataUrl("data:image/png;base64,AAA")).toEqual({
      mime: "image/png",
      base64: true,
      data: "AAA",
    });
    expect(host.parseDataUrl("https://example.test/a.png")).toBeNull();
  });

  it("recognises SVG bytes that arrived under a raster kind", () => {
    // `<img src="logo.svg">` is captured as an <img>, so the request goes out
    // as a raster. The mime is the only evidence of what came back, and the
    // renderer places vector art through a completely different API.
    expect(host.isVectorAsset({ kind: "raster", mime: "image/png" }, "image/png")).toBe(false);
    expect(host.isVectorAsset({ kind: "raster", mime: "image/png" }, "image/svg+xml")).toBe(true);
    expect(host.isVectorAsset({ kind: "raster", mime: "image/svg+xml" }, "")).toBe(true);
    expect(host.isVectorAsset({ kind: "svg", mime: "" }, "")).toBe(true);
  });
});

describe("object-fit", () => {
  const box = { top: 0, left: 0, width: 200, height: 100 };

  it("stretches to the box for fill, which is what the box always did", () => {
    expect(host.fitImage(box, { width: 50, height: 50 }, "fill", null)).toEqual({
      top: 0,
      left: 0,
      width: 200,
      height: 100,
      overflows: false,
    });
  });

  it("preserves the aspect ratio and centres for contain", () => {
    // A square image in a 2:1 box: height-limited, so 100x100 centred.
    const fitted = host.fitImage(box, { width: 50, height: 50 }, "contain", null);
    expect(fitted.width).toBe(100);
    expect(fitted.height).toBe(100);
    expect(fitted.left).toBe(50);
    expect(fitted.top).toBe(0);
    expect(fitted.overflows).toBe(false);
  });

  it("fills the box and overflows for cover", () => {
    // Same square, now width-limited: 200x200, overflowing 100pt vertically.
    const fitted = host.fitImage(box, { width: 50, height: 50 }, "cover", null);
    expect(fitted.width).toBe(200);
    expect(fitted.height).toBe(200);
    expect(fitted.left).toBe(0);
    // Centred vertically: the crop takes 50pt off each end.
    expect(fitted.top).toBe(50);
    expect(fitted.overflows).toBe(true);
  });

  it("keeps the intrinsic size for none, and crops if it does not fit", () => {
    const small = host.fitImage(box, { width: 40, height: 20 }, "none", null);
    expect(small.width).toBe(40);
    expect(small.height).toBe(20);
    expect(small.overflows).toBe(false);

    const large = host.fitImage(box, { width: 400, height: 400 }, "none", null);
    expect(large.width).toBe(400);
    expect(large.overflows).toBe(true);
  });

  it("scale-down never enlarges but does shrink", () => {
    // Smaller than the box: left alone, unlike contain which would grow it.
    expect(host.fitImage(box, { width: 40, height: 20 }, "scale-down", null).width).toBe(40);
    expect(host.fitImage(box, { width: 40, height: 20 }, "contain", null).width).toBe(200);
    // Larger than the box: identical to contain.
    expect(host.fitImage(box, { width: 400, height: 400 }, "scale-down", null).width).toBe(100);
  });

  it("distributes the leftover space by object-position", () => {
    const left = host.fitImage(box, { width: 50, height: 50 }, "contain", { x: 0, y: 0 });
    expect(left.left).toBe(0);
    const right = host.fitImage(box, { width: 50, height: 50 }, "contain", { x: 1, y: 0 });
    expect(right.left).toBe(100);
  });

  it("moves a cropped image the other way, because the leftover is negative", () => {
    // y = 0 means "show the top of the image", so its top edge sits on the
    // box's top edge and the overflow all hangs off the bottom.
    const top = host.fitImage(box, { width: 50, height: 50 }, "cover", { x: 0.5, y: 0 });
    expect(top.top).toBe(0);
    const bottom = host.fitImage(box, { width: 50, height: 50 }, "cover", { x: 0.5, y: 1 });
    // Artboard y grows upwards, so "flush bottom" is 100pt higher a top edge.
    expect(bottom.top).toBe(100);
  });

  it("falls back to the box when there is no intrinsic size", () => {
    const fitted = host.fitImage(box, { width: 0, height: 0 }, "cover", null);
    expect(fitted).toEqual({ top: 0, left: 0, width: 200, height: 100, overflows: false });
  });
});

describe("render — document", () => {
  it("creates an RGB document the size of the captured page", () => {
    const { doc } = render(scene(node({ paint: { radius: [0, 0, 0, 0], opacity: 1 } })));
    expect(doc.colorSpace).toBe("RGB");
    expect(doc.width).toBe(800);
    expect(doc.height).toBe(600);
  });

  it("refuses a page beyond Illustrator's artboard limit, with a usable message", () => {
    files["/scene.json"] = JSON.stringify(
      scene(node({}), {
        source: {
          ...(scene(node({})) as { source: object }).source,
          document: { w: 800, h: 20000 },
        },
      }),
    );
    host.loadSceneFile("/scene.json");
    expect(() => host.renderBegin()).toThrow(/artboard limit/);
  });

  it("places a box at the flipped coordinate", () => {
    const { doc } = render(
      scene(
        node({
          frame: { x: 10, y: 20, w: 100, h: 50 },
          paint: { radius: [0, 0, 0, 0], opacity: 1, fill: solid(255, 0, 0) },
        }),
      ),
    );
    const rect = allItems(doc.layers[0]!).find((i) => i.kind === "path");
    expect(rect?.top).toBe(-20);
    expect(rect?.left).toBe(10);
    expect(rect?.fillColor).toMatchObject({ red: 255, green: 0, blue: 0 });
  });

  it("uses roundedRectangle for uniform corners and a Bezier path for mixed ones", () => {
    const uniform = render(
      scene(
        node({
          paint: { radius: [8, 8, 8, 8], opacity: 1, fill: solid(0, 0, 0) },
        }),
      ),
    );
    const uniformRect = allItems(uniform.doc.layers[0]!).find((i) => i.kind === "path");
    expect(uniformRect?.radiusH).toBe(8);

    boot();
    const mixed = render(
      scene(
        node({
          paint: { radius: [24, 4, 24, 4], opacity: 1, fill: solid(0, 0, 0) },
        }),
      ),
    );
    const mixedRect = allItems(mixed.doc.layers[0]!).find((i) => i.kind === "path");
    expect(mixedRect?.radiusH).toBeUndefined();
    expect(mixedRect?.pathPoints.length).toBe(8);
  });
});

describe("render — z-order and structure", () => {
  it("puts the last child on top, matching back-to-front scene order", () => {
    const { doc } = render(
      scene(
        node({
          name: "root",
          children: [
            node({
              id: "a",
              name: "behind",
              paint: { radius: [0, 0, 0, 0], opacity: 1, fill: solid(1, 1, 1) },
            }),
            node({
              id: "b",
              name: "front",
              paint: { radius: [0, 0, 0, 0], opacity: 1, fill: solid(2, 2, 2) },
            }),
          ],
        }),
      ),
    );

    // Leaf nodes are drawn as paths in their parent's container, not as layers
    // of their own. Illustrator index 0 is topmost, and "front" was painted
    // last, so it must be there.
    const rootLayer = allLayers(doc.layers[0]!).find((l) => l.name === "root");
    expect(rootLayer?.items.map((i) => i.name)).toEqual(["front", "behind"]);
  });

  it("draws a node's own background beneath its children", () => {
    const { doc } = render(
      scene(
        node({
          name: "parent",
          paint: { radius: [0, 0, 0, 0], opacity: 1, fill: solid(9, 9, 9) },
          children: [
            node({
              id: "c",
              name: "child",
              paint: { radius: [0, 0, 0, 0], opacity: 1, fill: solid(1, 1, 1) },
            }),
          ],
        }),
      ),
    );

    const parentLayer = allLayers(doc.layers[0]!).find((l) => l.name === "parent");
    // Index 0 is topmost, so the parent's own background must be *last*: it was
    // added before the child and therefore sits underneath it.
    const names = parentLayer?.items.map((i) => i.name);
    expect(names).toEqual(["child", "parent"]);
    expect(parentLayer?.items[1]?.fillColor).toMatchObject({ red: 9 });
  });

  it("switches from layers to groups past the configured depth", () => {
    // maxLayerDepth is 4 in config/web2ai.config.json.
    let deepest = node({
      id: "d7",
      name: "level7",
      paint: { radius: [0, 0, 0, 0], opacity: 1, fill: solid(1, 1, 1) },
    });
    for (let level = 6; level >= 1; level -= 1) {
      deepest = node({ id: `d${level}`, name: `level${level}`, children: [deepest] });
    }

    const { doc, report } = render(scene(deepest));
    const layerNames = allLayers(doc.layers[0]!).map((l) => l.name);

    // Levels 1-4 are layers; below that the builder uses groups.
    expect(layerNames).toContain("level1");
    expect(layerNames).toContain("level4");
    expect(layerNames).not.toContain("level6");
    expect(report.rows.some((r) => r.code === "layer-depth-exceeded")).toBe(true);
  });

  it("deduplicates sibling names so the palette stays navigable", () => {
    const { doc } = render(
      scene(
        node({
          name: "list",
          children: [
            node({
              id: "1",
              name: "li.item",
              paint: { radius: [0, 0, 0, 0], opacity: 1, fill: solid(1, 1, 1) },
            }),
            node({
              id: "2",
              name: "li.item",
              paint: { radius: [0, 0, 0, 0], opacity: 1, fill: solid(1, 1, 1) },
            }),
          ],
        }),
      ),
    );
    const listLayer = allLayers(doc.layers[0]!).find((l) => l.name === "list");
    // Leaves keep their own names; duplicates only need disambiguating when
    // they become containers, which is what uniqueName does.
    expect(listLayer?.items.map((i) => i.name)).toEqual(["li.item", "li.item"]);
  });

  it("disambiguates duplicate names when siblings become layers", () => {
    const child = () =>
      node({
        id: "x",
        name: "span",
        paint: { radius: [0, 0, 0, 0], opacity: 1, fill: solid(1, 1, 1) },
      });
    const { doc } = render(
      scene(
        node({
          name: "list",
          children: [
            node({ id: "1", name: "li.item", children: [child()] }),
            node({ id: "2", name: "li.item", children: [child()] }),
          ],
        }),
      ),
    );
    const names = allLayers(doc.layers[0]!).map((l) => l.name);
    expect(names).toContain("li.item");
    expect(names).toContain("li.item (2)");
  });

  it("adds the clip mask last, so it is the topmost item", () => {
    const { doc } = render(
      scene(
        node({
          name: "scroller",
          clip: true,
          paint: { radius: [0, 0, 0, 0], opacity: 1, fill: solid(1, 1, 1) },
          children: [
            node({
              id: "c",
              name: "content",
              paint: { radius: [0, 0, 0, 0], opacity: 1, fill: solid(2, 2, 2) },
            }),
          ],
        }),
      ),
    );

    const layer = allLayers(doc.layers[0]!).find((l) => l.name === "scroller");
    // Illustrator clips with the topmost object, which is index 0.
    expect(layer?.items[0]?.name).toBe("clip");
    expect(layer?.clipped).toBe(true);
  });
});

describe("render — paint", () => {
  it("builds a gradient with the converted angle", () => {
    const { doc } = render(
      scene(
        node({
          paint: {
            radius: [0, 0, 0, 0],
            opacity: 1,
            fill: {
              kind: "linear-gradient",
              angle: 90,
              stops: [
                { color: { r: 255, g: 0, b: 0, a: 1 }, offset: 0 },
                { color: { r: 0, g: 0, b: 255, a: 1 }, offset: 1 },
              ],
            },
          },
        }),
      ),
    );
    expect(doc.gradients).toHaveLength(1);
    expect(doc.gradients[0]?.gradientStops).toHaveLength(2);
    const rect = allItems(doc.layers[0]!).find((i) => i.kind === "path");
    expect(rect?.fillColor).toMatchObject({ angle: 0 });
  });

  it("draws four separate edges for unequal borders and reports it", () => {
    const { doc, report } = render(
      scene(
        node({
          paint: {
            radius: [0, 0, 0, 0],
            opacity: 1,
            stroke: {
              widths: [6, 2, 6, 2],
              color: { r: 0, g: 0, b: 0, a: 1 },
              style: "solid",
              colors: [
                { r: 1, g: 0, b: 0, a: 1 },
                { r: 2, g: 0, b: 0, a: 1 },
                { r: 3, g: 0, b: 0, a: 1 },
                { r: 4, g: 0, b: 0, a: 1 },
              ],
            },
          },
        }),
      ),
    );
    const borders = allItems(doc.layers[0]!).filter((i) => i.name.indexOf("border") === 0);
    expect(borders).toHaveLength(4);
    expect(report.rows.some((r) => r.code === "border-widths-differ")).toBe(true);
  });

  it("strokes a single path when all borders match", () => {
    const { doc } = render(
      scene(
        node({
          paint: {
            radius: [0, 0, 0, 0],
            opacity: 1,
            stroke: { widths: [2, 2, 2, 2], color: { r: 0, g: 0, b: 0, a: 1 }, style: "solid" },
          },
        }),
      ),
    );
    const stroked = allItems(doc.layers[0]!).filter((i) => i.stroked === true);
    expect(stroked).toHaveLength(1);
    expect(stroked[0]?.strokeWidth).toBe(2);
  });

  it("applies the first shadow and reports the rest instead of dropping them", () => {
    const { doc, report } = render(
      scene(
        node({
          paint: {
            radius: [0, 0, 0, 0],
            opacity: 1,
            fill: solid(255, 255, 255),
            shadows: [
              {
                inset: false,
                offsetX: 0,
                offsetY: 2,
                blur: 4,
                spread: 0,
                color: { r: 0, g: 0, b: 0, a: 0.2 },
              },
              {
                inset: false,
                offsetX: 0,
                offsetY: 8,
                blur: 16,
                spread: 0,
                color: { r: 0, g: 0, b: 0, a: 0.1 },
              },
            ],
          },
        }),
      ),
    );
    const shadowed = allItems(doc.layers[0]!).find((i) => i.effects.length > 0);
    expect(shadowed?.effects[0]).toContain("Adobe Drop Shadow");
    expect(report.rows.some((r) => r.code === "shadow-multiple")).toBe(true);
  });

  it("reports an inset shadow rather than faking one", () => {
    const { report } = render(
      scene(
        node({
          paint: {
            radius: [0, 0, 0, 0],
            opacity: 1,
            fill: solid(255, 255, 255),
            shadows: [
              {
                inset: true,
                offsetX: 0,
                offsetY: 2,
                blur: 4,
                spread: 0,
                color: { r: 0, g: 0, b: 0, a: 0.2 },
              },
            ],
          },
        }),
      ),
    );
    expect(report.rows.some((r) => r.code === "shadow-inset")).toBe(true);
  });
});

describe("render — text", () => {
  const run = (chars: string, overrides: Record<string, unknown> = {}) => ({
    chars,
    font: { family: "Arial", weight: 400, style: "normal", isWebFont: false },
    size: 16,
    color: { r: 0, g: 0, b: 0, a: 1 },
    lineHeight: 20,
    letterSpacing: 0,
    align: "left",
    ...overrides,
  });

  it("uses point text for a single line", () => {
    const { doc } = render(
      scene(node({ role: "text", text: { runs: [run("Hello")], isSingleLine: true } })),
    );
    const text = allItems(doc.layers[0]!).find((i) => i.kind === "text");
    expect(text?.contents).toBe("Hello");
  });

  it("uses area text for multiple lines, with a path to flow into", () => {
    const { doc } = render(
      scene(
        node({
          frame: { x: 0, y: 0, w: 200, h: 80 },
          role: "text",
          text: { runs: [run("A long paragraph")], isSingleLine: false },
        }),
      ),
    );
    const items = allItems(doc.layers[0]!);
    expect(items.find((i) => i.kind === "text")?.contents).toBe("A long paragraph");
    expect(items.some((i) => i.kind === "path")).toBe(true);
  });

  it("concatenates runs into one frame", () => {
    const { doc } = render(
      scene(
        node({
          role: "text",
          text: {
            runs: [
              run("plain "),
              run("bold", {
                font: { family: "Arial", weight: 700, style: "normal", isWebFont: false },
              }),
            ],
            isSingleLine: true,
          },
        }),
      ),
    );
    expect(allItems(doc.layers[0]!).find((i) => i.kind === "text")?.contents).toBe("plain bold");
  });

  it("records a font substitution instead of substituting quietly", () => {
    const { report } = render(
      scene(
        node({
          role: "text",
          text: {
            runs: [
              run("x", {
                font: { family: "Nonexistent Sans", weight: 400, style: "normal", isWebFont: true },
              }),
            ],
            isSingleLine: true,
          },
        }),
      ),
    );
    expect(report.fontSubstitutions.length).toBeGreaterThan(0);
    expect(report.fontSubstitutions[0]?.requested).toContain("Nonexistent Sans");
  });
});

describe("font matching", () => {
  it("reads a weight out of an Illustrator style name", () => {
    expect(host.weightOfStyleName("Thin")).toBe(100);
    expect(host.weightOfStyleName("Light")).toBe(300);
    expect(host.weightOfStyleName("Regular")).toBe(400);
    expect(host.weightOfStyleName("Medium")).toBe(500);
    expect(host.weightOfStyleName("SemiBold")).toBe(600);
    expect(host.weightOfStyleName("Bold")).toBe(700);
    expect(host.weightOfStyleName("Black")).toBe(900);
    // A style name that says nothing about weight is the regular cut.
    expect(host.weightOfStyleName("Italic")).toBe(400);
    expect(host.weightOfStyleName("")).toBe(400);
  });

  it("does not file ExtraBold as Bold, or UltraLight as Light", () => {
    // The whole point of the ordered table: every short weight name is a
    // substring of a longer one.
    expect(host.weightOfStyleName("ExtraBold")).toBe(800);
    expect(host.weightOfStyleName("SemiBold Italic")).toBe(600);
    expect(host.weightOfStyleName("UltraLight")).toBe(200);
    expect(host.weightOfStyleName("Extra Light")).toBe(300);
  });

  it("recognises slant under either name", () => {
    expect(host.isItalicStyleName("Bold Italic")).toBe(true);
    expect(host.isItalicStyleName("Oblique")).toBe(true);
    expect(host.isItalicStyleName("Bold")).toBe(false);
  });

  it("picks the cut the page asked for, not just bold or not-bold", () => {
    const at = (weight: number, style = "normal") =>
      host.resolveFont({ family: "Inter", weight, style, isWebFont: false }).used;

    expect(at(100)).toBe("Inter-Thin");
    expect(at(300)).toBe("Inter-Light");
    expect(at(400)).toBe("Inter-Regular");
    expect(at(500)).toBe("Inter-Medium");
    expect(at(600)).toBe("Inter-SemiBold");
    expect(at(700)).toBe("Inter-Bold");
    expect(at(900)).toBe("Inter-Black");
  });

  it("takes the nearest weight when the exact cut is missing", () => {
    // Arial has Regular and Bold only.
    const at = (weight: number) =>
      host.resolveFont({ family: "Arial", weight, style: "normal", isWebFont: false }).used;
    expect(at(300)).toBe("ArialMT");
    expect(at(900)).toBe("Arial-BoldMT");
    // 500 goes DOWN to 400, not up to 700: CSS checks 400-500 in ascending
    // order first, then everything below the target, and only then above 500.
    expect(at(500)).toBe("ArialMT");
  });

  it("prefers the heavier face inside the 400-500 band, as CSS does", () => {
    const at = (weight: number) =>
      host.resolveFont({ family: "Inter", weight, style: "normal", isWebFont: false }).used;
    expect(at(450)).toBe("Inter-Medium");
    // Below the band the tie goes the other way.
    expect(at(350)).toBe("Inter-Regular");
  });

  it("never trades slant for weight", () => {
    // Inter has no Light Italic. An upright Light would match the weight
    // exactly; Medium Italic is still the better face.
    const resolved = host.resolveFont({
      family: "Inter",
      weight: 300,
      style: "italic",
      isWebFont: false,
    });
    expect(resolved.used).toBe("Inter-MediumItalic");
  });

  it("does not hand out a condensed face to a page that did not ask for one", () => {
    const resolved = host.resolveFont({
      family: "Helvetica Neue",
      weight: 700,
      style: "normal",
      isWebFont: false,
    });
    expect(resolved.used).toBe("HelveticaNeue-Bold");
  });

  it("matches family names across spacing and case", () => {
    expect(host.normaliseFamily("Helvetica Neue")).toBe(host.normaliseFamily("HelveticaNeue"));
    expect(host.normaliseFamily('"Inter"')).toBe("inter");
    expect(host.normaliseFamily("Inter")).not.toBe(host.normaliseFamily("Inter Tight"));
  });

  it("walks the CSS stack instead of jumping to the global fallback", () => {
    const stack = host.familyStack({ family: "Brand Sans", stack: '"Brand Sans", Inter, Arial' });
    expect(stack).toEqual(["Brand Sans", "Inter", "Arial"]);

    // Brand Sans is a web font nobody has; the browser would have drawn Inter,
    // so that is what the document should get.
    const resolved = host.resolveFont({
      family: "Brand Sans",
      weight: 600,
      style: "normal",
      isWebFont: true,
      stack: '"Brand Sans", Inter, Arial',
    });
    expect(resolved.used).toBe("Inter-SemiBold");
    // Still a substitution: the page asked for a font that is not here.
    expect(resolved.substituted).toBe(true);
  });
});

describe("render — images", () => {
  const png =
    "data:image/png;base64," + Buffer.from("not really a png", "binary").toString("base64");

  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="40"><path d="M0 0h120v40H0z"/></svg>';

  const imageScene = (nodeOverrides: Record<string, unknown>, asset: Record<string, unknown>) =>
    scene(
      node({
        role: "image",
        frame: { x: 0, y: 0, w: 200, h: 100 },
        assetId: "a1",
        ...nodeOverrides,
      }),
      { assets: [{ id: "a1", width: 100, height: 100, ...asset }] },
    );

  it("places a raster through placedItems", () => {
    const { doc } = render(imageScene({}, { kind: "raster", mime: "image/png", dataUrl: png }));
    const placed = allItems(doc.layers[0]!).find((i) => i.kind === "placed");
    expect(placed?.name).toBe("div");
    expect(placed?.width).toBe(200);
    expect(placed?.height).toBe(100);
  });

  it("imports an SVG as vector art, not through placedItems", () => {
    // placedItems cannot place an SVG. This is why the logo was missing.
    const { doc, report } = render(
      imageScene({ role: "svg", name: "logo" }, { kind: "svg", mime: "image/svg+xml", svg }),
    );
    const items = allItems(doc.layers[0]!);
    expect(items.some((i) => i.kind === "placed")).toBe(false);
    const imported = items.find((i) => i.kind === "imported");
    expect(imported).toBeDefined();
    expect(imported?.file).toBe("/tmp/web2ai/assets/a1.svg");
    expect(report.rows.some((r) => r.code === "svg-import-failed")).toBe(false);
  });

  it("routes an <img> that turned out to be SVG through the vector path too", () => {
    const dataUrl = "data:image/svg+xml;base64," + Buffer.from(svg, "binary").toString("base64");
    const { doc } = render(
      imageScene({ name: "logo" }, { kind: "raster", mime: "image/svg+xml", dataUrl }),
    );
    expect(allItems(doc.layers[0]!).some((i) => i.kind === "imported")).toBe(true);
  });

  it("stretches to the box only when object-fit says fill", () => {
    const { doc } = render(
      imageScene({ role: "svg" }, { kind: "svg", mime: "image/svg+xml", svg }),
    );
    // No objectFit on the node: the old behaviour, and the CSS default.
    const imported = allItems(doc.layers[0]!).find((i) => i.kind === "imported");
    expect(imported?.width).toBe(200);
    expect(imported?.height).toBe(100);
  });

  it("keeps the aspect ratio for contain", () => {
    const { doc } = render(
      imageScene(
        { role: "svg", objectFit: "contain" },
        { kind: "svg", mime: "image/svg+xml", svg },
      ),
    );
    // The SVG is 120x40 (3:1) inside a 200x100 box: width-limited to 200x66.7.
    const imported = allItems(doc.layers[0]!).find((i) => i.kind === "imported");
    expect(imported?.width).toBeCloseTo(200, 5);
    expect(imported?.height).toBeCloseTo(200 / 3, 5);
  });

  it("crops instead of letting a cover image paint over its neighbours", () => {
    const { doc } = render(
      imageScene({ role: "svg", objectFit: "cover" }, { kind: "svg", mime: "image/svg+xml", svg }),
    );
    const items = allItems(doc.layers[0]!);
    const group = items.find((i) => i.kind === "group" && i.clipped === true);
    expect(group).toBeDefined();
    // The mask is the topmost object in the group, which is how Illustrator
    // decides what clips what.
    expect(group?.children?.items[0]?.name).toBe("crop");
    // 3:1 art in a 2:1 box is height-limited, so it overflows horizontally.
    const imported = items.find((i) => i.kind === "imported");
    expect(imported?.height).toBeCloseTo(100, 5);
    expect(imported?.width).toBeCloseTo(300, 5);
  });

  it("says so when object-fit needs an intrinsic size it does not have", () => {
    const { report } = render(
      imageScene(
        { objectFit: "cover" },
        { kind: "raster", mime: "image/png", dataUrl: png, width: 0, height: 0 },
      ),
    );
    expect(report.rows.some((r) => r.code === "object-fit-no-intrinsic-size")).toBe(true);
  });
});

describe("render — resilience and reporting", () => {
  it("keeps going when one node throws, and counts the failure", () => {
    const bad = node({
      id: "bad",
      name: "broken",
      // A frame of nulls makes the geometry throw, which is what a corrupted
      // scene looks like in practice.
      frame: null,
      paint: { radius: [0, 0, 0, 0], opacity: 1, fill: solid(1, 1, 1) },
    });
    const good = node({
      id: "good",
      name: "fine",
      paint: { radius: [0, 0, 0, 0], opacity: 1, fill: solid(2, 2, 2) },
    });

    const { doc, report } = render(scene(node({ name: "root", children: [bad, good] })));

    expect(report.nodesFailed).toBe(1);
    expect(report.rows.some((r) => r.code === "node-render-failed")).toBe(true);
    // The healthy sibling still rendered.
    const rootLayer = allLayers(doc.layers[0]!).find((l) => l.name === "root");
    expect(rootLayer?.items.map((i) => i.name)).toContain("fine");
  });

  it("carries capture-side reasons into the import report", () => {
    const { report } = render(
      scene(
        node({
          name: "filtered",
          unsupportedReasons: ["css-filter", "backdrop-filter"],
          paint: { radius: [0, 0, 0, 0], opacity: 1, fill: solid(1, 1, 1) },
        }),
      ),
    );
    expect(report.rows.map((r) => r.code)).toContain("css-filter");
    expect(report.rows.map((r) => r.code)).toContain("backdrop-filter");
  });

  it("aggregates repeated reasons into one row with a count", () => {
    const children = [];
    for (let i = 0; i < 12; i += 1) {
      children.push(
        node({
          id: `n${i}`,
          name: `child${i}`,
          unsupportedReasons: ["css-filter"],
          paint: { radius: [0, 0, 0, 0], opacity: 1, fill: solid(1, 1, 1) },
        }),
      );
    }
    const { report } = render(scene(node({ name: "root", children })));
    const row = report.rows.find((r) => r.code === "css-filter");
    expect(row?.count).toBe(12);
    // Examples are capped so the report stays readable.
    expect(row?.examples.length).toBeLessThanOrEqual(5);
  });

  it("marks an unsupported node without trying to draw it", () => {
    const { report } = render(
      scene(node({ name: "iframe", role: "unsupported", unsupportedReasons: ["iframe-content"] })),
    );
    expect(report.rows.some((r) => r.code === "iframe-content")).toBe(true);
  });

  it("can be cancelled mid-render and says so", () => {
    const children = [];
    for (let i = 0; i < 40; i += 1) {
      children.push(
        node({
          id: `n${i}`,
          name: `child${i}`,
          paint: { radius: [0, 0, 0, 0], opacity: 1, fill: solid(1, 1, 1) },
        }),
      );
    }
    files["/scene.json"] = JSON.stringify(scene(node({ name: "root", children })));
    host.loadSceneFile("/scene.json");
    const begin = host.renderBegin();
    expect(begin.total).toBe(41);

    host.renderStep(5);
    const report = host.renderFinish(true);

    expect(report.cancelled).toBe(true);
    expect(report.nodesBuilt).toBeLessThan(report.nodesTotal);
    expect(report.rows.some((r) => r.code === "render-cancelled")).toBe(true);
  });

  it("reports a clean page as clean", () => {
    const { report } = render(
      scene(node({ paint: { radius: [0, 0, 0, 0], opacity: 1, fill: solid(1, 1, 1) } })),
    );
    expect(report.rows.filter((r) => r.level === "unsupported")).toEqual([]);
    expect(report.nodesFailed).toBe(0);
  });

  it("renders the report as Markdown with the page and the reasons", () => {
    render(
      scene(
        node({
          name: "filtered",
          unsupportedReasons: ["css-filter"],
          paint: { radius: [0, 0, 0, 0], opacity: 1, fill: solid(1, 1, 1) },
        }),
      ),
    );
    const markdown = host.reportMarkdown(host._lastReport, host._lastReportScene);
    expect(markdown).toContain("# web2ai import report");
    expect(markdown).toContain("https://example.test/");
    expect(markdown).toContain("`css-filter`");
    expect(markdown).toContain("| Level | Code | Count |");
  });

  it("escapes pipes so a URL cannot break the Markdown table", () => {
    render(
      scene(
        node({
          name: "a|b",
          unsupportedReasons: ["css-filter"],
          paint: { radius: [0, 0, 0, 0], opacity: 1, fill: solid(1, 1, 1) },
        }),
      ),
    );
    const markdown = host.reportMarkdown(host._lastReport, host._lastReportScene);
    expect(markdown).toContain("a\\|b");
  });
});

describe("render — real fixtures", () => {
  const fixtures = ["landing-page", "stacking", "typography"];

  it.each(fixtures)("renders the %s fixture without failing a node", (name) => {
    const captured = JSON.parse(
      readFileSync(join(repoRoot, "fixtures", name, "expected-scene.json"), "utf8"),
    );
    const { doc, report } = render(captured);

    expect(report.nodesFailed).toBe(0);
    expect(report.nodesBuilt).toBe(report.nodesTotal);
    expect(doc.width).toBeGreaterThan(0);
    expect(allItems(doc.layers[0]!).length).toBeGreaterThan(0);
  });

  it("mirrors the DOM hierarchy in the layer palette", () => {
    const captured = JSON.parse(
      readFileSync(join(repoRoot, "fixtures", "landing-page", "expected-scene.json"), "utf8"),
    );
    const { doc } = render(captured);
    const names = allLayers(doc.layers[0]!).map((l) => l.name);

    expect(names).toContain("header.topbar");
    expect(names).toContain("section.hero");
    expect(names).toContain("section#features.cards");
  });
});
