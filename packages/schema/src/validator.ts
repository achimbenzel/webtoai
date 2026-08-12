import { z } from "zod";
import type { AssetRequest, Scene, SceneNode } from "./types.ts";

const finite = z.number().finite();

export const rgbaSchema = z.object({
  r: z.number().int().min(0).max(255),
  g: z.number().int().min(0).max(255),
  b: z.number().int().min(0).max(255),
  a: z.number().min(0).max(1),
});

export const fontStyleSchema = z.enum(["normal", "italic", "oblique"]);

export const fontRefSchema = z.object({
  family: z.string(),
  weight: z.number().int().min(1).max(1000),
  style: fontStyleSchema,
  isWebFont: z.boolean(),
  stack: z.string().optional(),
});

export const gradientStopSchema = z.object({
  color: rgbaSchema,
  offset: z.number().min(0).max(1),
});

export const paintSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("solid"), color: rgbaSchema }),
  z.object({
    kind: z.literal("linear-gradient"),
    angle: finite,
    stops: z.array(gradientStopSchema).min(2),
  }),
  z.object({
    kind: z.literal("radial-gradient"),
    shape: z.enum(["circle", "ellipse"]),
    center: z.object({ x: finite, y: finite }),
    radius: z.object({ x: finite, y: finite }),
    stops: z.array(gradientStopSchema).min(2),
  }),
]);

export const shadowSchema = z.object({
  inset: z.boolean(),
  offsetX: finite,
  offsetY: finite,
  blur: finite.min(0),
  spread: finite,
  color: rgbaSchema,
});

export const borderStyleSchema = z.enum([
  "none",
  "hidden",
  "solid",
  "dashed",
  "dotted",
  "double",
  "groove",
  "ridge",
  "inset",
  "outset",
]);

const quadSchema = z.tuple([finite, finite, finite, finite]);

export const strokeSchema = z.object({
  widths: quadSchema,
  color: rgbaSchema,
  style: borderStyleSchema,
  colors: z.tuple([rgbaSchema, rgbaSchema, rgbaSchema, rgbaSchema]).optional(),
  styles: z
    .tuple([borderStyleSchema, borderStyleSchema, borderStyleSchema, borderStyleSchema])
    .optional(),
});

export const nodePaintSchema = z.object({
  fill: paintSchema.optional(),
  stroke: strokeSchema.optional(),
  radius: quadSchema,
  shadows: z.array(shadowSchema).optional(),
  opacity: z.number().min(0).max(1),
  blendMode: z.string().optional(),
});

export const textAlignSchema = z.enum(["left", "right", "center", "justify", "start", "end"]);

export const textRunSchema = z.object({
  chars: z.string(),
  font: fontRefSchema,
  size: finite.min(0),
  color: rgbaSchema,
  lineHeight: finite.min(0),
  letterSpacing: finite,
  align: textAlignSchema,
  decoration: z.enum(["none", "underline", "line-through", "overline"]).optional(),
});

export const textContentSchema = z.object({
  runs: z.array(textRunSchema),
  isSingleLine: z.boolean(),
});

export const assetSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(["raster", "svg"]),
  mime: z.string(),
  src: z.string().optional(),
  dataUrl: z.string().optional(),
  svg: z.string().optional(),
  width: finite.min(0),
  height: finite.min(0),
  error: z.string().optional(),
});

export const frameSchema = z.object({ x: finite, y: finite, w: finite.min(0), h: finite.min(0) });

export const sceneNodeSchema: z.ZodType<SceneNode> = z.lazy(() =>
  z.object({
    id: z.string().min(1),
    name: z.string(),
    role: z.enum(["box", "text", "image", "svg", "unsupported"]),
    frame: frameSchema,
    paint: nodePaintSchema,
    text: textContentSchema.optional(),
    assetId: z.string().optional(),
    clip: z.boolean(),
    transform: z.array(finite).length(6).optional(),
    transformOrigin: z.object({ x: finite, y: finite }).optional(),
    cssPosition: z.enum(["static", "relative", "absolute", "fixed", "sticky"]).optional(),
    stackingOrder: z.number().int().min(0),
    unsupportedReasons: z.array(z.string()).optional(),
    children: z.array(sceneNodeSchema),
  }),
);

export const captureOptionsSchema = z.object({
  fullPage: z.boolean(),
  rootSelector: z.string(),
  textAsOutlines: z.boolean(),
  embedImages: z.boolean(),
  maxDepth: z.number().int().min(1),
  minNodeArea: finite.min(0),
  skipSelectors: z.array(z.string()),
  capturePseudoElements: z.boolean(),
  captureCanvas: z.boolean(),
});

export const sceneSourceSchema = z.object({
  url: z.string(),
  title: z.string(),
  capturedAt: z.string(),
  viewport: z.object({ w: finite.min(0), h: finite.min(0), dpr: finite.min(0) }),
  document: z.object({ w: finite.min(0), h: finite.min(0) }),
});

export const sceneSchema = z.object({
  version: z.literal(1),
  source: sceneSourceSchema,
  options: captureOptionsSchema,
  fonts: z.array(fontRefSchema),
  assets: z.array(assetSchema),
  root: sceneNodeSchema,
});

export const assetRequestSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(["raster", "svg"]),
  url: z.string().optional(),
  inline: z.object({ mime: z.string(), data: z.string() }).optional(),
  width: finite.min(0),
  height: finite.min(0),
});

export interface ValidationIssue {
  path: string;
  message: string;
}

export type ValidationResult<T> =
  { ok: true; value: T } | { ok: false; issues: ValidationIssue[]; message: string };

function toIssues(error: z.ZodError): ValidationIssue[] {
  return error.issues.map((issue) => ({
    path: issue.path.length > 0 ? issue.path.join(".") : "(root)",
    message: issue.message,
  }));
}

function run<T>(schema: z.ZodType<T>, data: unknown, label: string): ValidationResult<T> {
  const parsed = schema.safeParse(data);
  if (parsed.success) return { ok: true, value: parsed.data };
  const issues = toIssues(parsed.error);
  const head = issues
    .slice(0, 5)
    .map((i) => `  ${i.path}: ${i.message}`)
    .join("\n");
  const more = issues.length > 5 ? `\n  … and ${issues.length - 5} more` : "";
  return { ok: false, issues, message: `${label} failed validation:\n${head}${more}` };
}

/** Validate a scene. Both sides call this: capture on output, host on input. */
export function validateScene(data: unknown): ValidationResult<Scene> {
  return run(sceneSchema, data, "Scene (ui-scene@1)");
}

export function validateAssetRequest(data: unknown): ValidationResult<AssetRequest> {
  return run(assetRequestSchema, data, "AssetRequest");
}

/** Throwing variant for call sites where an invalid scene is a programming error. */
export function assertScene(data: unknown): Scene {
  const result = validateScene(data);
  if (!result.ok) throw new Error(result.message);
  return result.value;
}

/** Cheap structural counters used by the panel status display and the report. */
export function sceneStats(scene: Scene): {
  nodeCount: number;
  maxDepth: number;
  unsupportedCount: number;
  textCount: number;
  imageCount: number;
} {
  let nodeCount = 0;
  let maxDepth = 0;
  let unsupportedCount = 0;
  let textCount = 0;
  let imageCount = 0;

  const stack: Array<{ node: SceneNode; depth: number }> = [{ node: scene.root, depth: 1 }];
  while (stack.length > 0) {
    const entry = stack.pop();
    if (entry === undefined) break;
    nodeCount += 1;
    if (entry.depth > maxDepth) maxDepth = entry.depth;
    if (entry.node.role === "unsupported") unsupportedCount += 1;
    else if (entry.node.unsupportedReasons && entry.node.unsupportedReasons.length > 0) {
      unsupportedCount += 1;
    }
    if (entry.node.role === "text") textCount += 1;
    if (entry.node.role === "image" || entry.node.role === "svg") imageCount += 1;
    for (const child of entry.node.children) {
      stack.push({ node: child, depth: entry.depth + 1 });
    }
  }

  return { nodeCount, maxDepth, unsupportedCount, textCount, imageCount };
}
