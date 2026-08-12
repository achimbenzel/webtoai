import { describe, expect, it } from "vitest";
import { assertScene, sceneStats, validateScene } from "./validator.ts";
import { candidatePorts, config, defaultCaptureOptions, transportBaseUrl } from "./config.ts";
import type { Scene, SceneNode } from "./types.ts";

function node(partial: Partial<SceneNode> & Pick<SceneNode, "id" | "stackingOrder">): SceneNode {
  return {
    name: partial.name ?? "div",
    role: partial.role ?? "box",
    frame: partial.frame ?? { x: 0, y: 0, w: 10, h: 10 },
    paint: partial.paint ?? { radius: [0, 0, 0, 0], opacity: 1 },
    clip: partial.clip ?? false,
    children: partial.children ?? [],
    ...partial,
  };
}

function scene(root: SceneNode): Scene {
  return {
    version: 1,
    source: {
      url: "https://example.com/",
      title: "Example",
      capturedAt: "2026-01-01T00:00:00.000Z",
      viewport: { w: 1280, h: 800, dpr: 2 },
      document: { w: 1280, h: 2400 },
    },
    options: defaultCaptureOptions(),
    fonts: [],
    assets: [],
    root,
  };
}

describe("scene validation", () => {
  it("accepts a minimal valid scene", () => {
    const result = validateScene(scene(node({ id: "root", stackingOrder: 0 })));
    expect(result.ok).toBe(true);
  });

  it("validates recursively into children", () => {
    const bad = scene(
      node({
        id: "root",
        stackingOrder: 0,
        children: [
          node({
            id: "child",
            stackingOrder: 1,
            // Opacity above 1 must be caught even though it is nested.
            paint: { radius: [0, 0, 0, 0], opacity: 4 },
          }),
        ],
      }),
    );
    const result = validateScene(bad);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.some((i) => i.path === "root.children.0.paint.opacity")).toBe(true);
  });

  it("rejects an unknown schema version", () => {
    const bad = { ...scene(node({ id: "root", stackingOrder: 0 })), version: 2 };
    expect(validateScene(bad).ok).toBe(false);
  });

  it("rejects unknown roles", () => {
    const bad = scene(node({ id: "root", stackingOrder: 0, role: "video" as never }));
    expect(validateScene(bad).ok).toBe(false);
  });

  it("requires at least two gradient stops", () => {
    const bad = scene(
      node({
        id: "root",
        stackingOrder: 0,
        paint: {
          radius: [0, 0, 0, 0],
          opacity: 1,
          fill: {
            kind: "linear-gradient",
            angle: 90,
            stops: [{ color: { r: 0, g: 0, b: 0, a: 1 }, offset: 0 }],
          },
        },
      }),
    );
    expect(validateScene(bad).ok).toBe(false);
  });

  it("assertScene throws with a readable message", () => {
    expect(() => assertScene({ version: 1 })).toThrow(/ui-scene@1.*failed validation/s);
  });
});

describe("sceneStats", () => {
  it("counts nodes, depth and degraded nodes", () => {
    const tree = scene(
      node({
        id: "root",
        stackingOrder: 0,
        children: [
          node({ id: "a", stackingOrder: 1, role: "text" }),
          node({
            id: "b",
            stackingOrder: 2,
            children: [
              node({ id: "c", stackingOrder: 3, role: "image", assetId: "asset-1" }),
              node({
                id: "d",
                stackingOrder: 4,
                role: "unsupported",
                unsupportedReasons: ["iframe"],
              }),
            ],
          }),
        ],
      }),
    );
    expect(sceneStats(tree)).toEqual({
      nodeCount: 5,
      maxDepth: 3,
      unsupportedCount: 1,
      textCount: 1,
      imageCount: 1,
    });
  });
});

describe("config", () => {
  it("loads and validates config/web2ai.config.json", () => {
    expect(config.transport.port).toBeGreaterThan(0);
    expect(config.render.maxLayerDepth).toBeGreaterThanOrEqual(1);
  });

  it("derives the transport base url from config, never hardcoded", () => {
    expect(transportBaseUrl()).toBe(`http://${config.transport.host}:${config.transport.port}`);
    expect(transportBaseUrl(9000)).toBe(`http://${config.transport.host}:9000`);
  });

  it("produces the configured number of fallback ports", () => {
    const ports = candidatePorts();
    expect(ports).toHaveLength(config.transport.portFallbackRange + 1);
    expect(ports[0]).toBe(config.transport.port);
  });

  it("default capture options satisfy the scene schema", () => {
    const result = validateScene(scene(node({ id: "root", stackingOrder: 0 })));
    expect(result.ok).toBe(true);
  });
});
