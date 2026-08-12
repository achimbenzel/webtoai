import type {
  AssetRequest,
  CaptureOptions,
  CssPosition,
  FontRef,
  Frame,
  NodePaint,
  Paint,
  Scene,
  SceneNode,
  Stroke,
  TextContent,
  BorderStyle,
} from "@web2ai/schema";
import { AssetCollector, backgroundImageUrls, backgroundLayerCount } from "./assets.ts";
import { isTransparent, parseColorDetailed } from "./css/color.ts";
import { isGradient, parseGradient } from "./css/gradient.ts";
import { parseBorderRadius } from "./css/radius.ts";
import { parseBoxShadow } from "./css/shadow.ts";
import { parseTransform, parseTransformOrigin } from "./css/transform.ts";
import { clamp, parseLength, round, splitTopLevel, stripQuotes } from "./css/values.ts";
import type { CaptureEnv, DomElementLike, RectLike, StyleLike } from "./dom.ts";
import { childElementsOf, isSvgElement, tagNameOf } from "./dom.ts";
import { CaptureLog } from "./log.ts";
import { deduplicateNames, nodeId, nodeName } from "./naming.ts";
import type { StackingInput } from "./stacking.ts";
import { paintOrderIndex } from "./stacking.ts";
import { extractText, pseudoRun } from "./text.ts";

export interface WalkResult {
  /** Complete except for `assets`, which the async pass fills in. */
  scene: Scene;
  assetRequests: AssetRequest[];
  log: CaptureLog;
}

/** Elements that carry no paint of their own and never should be walked. */
const NEVER_WALK = new Set([
  "script",
  "style",
  "noscript",
  "template",
  "link",
  "meta",
  "title",
  "head",
  "base",
]);

/** Elements whose content a vector document cannot reach into. */
const OPAQUE_ELEMENTS: Readonly<Record<string, string>> = {
  iframe: "iframe-content",
  frame: "iframe-content",
  video: "video-element",
  audio: "audio-element",
  object: "embedded-object",
  embed: "embedded-object",
};

/** Elements that are leaves for capture purposes. */
const LEAF_ELEMENTS = new Set(["img", "canvas", "svg", "input", "textarea", "select", "br", "hr"]);

const BORDER_SIDES = ["top", "right", "bottom", "left"] as const;

interface Built {
  node: SceneNode;
  stack: StackingInput;
}

function toBorderStyle(value: string): BorderStyle {
  const normalised = value.trim().toLowerCase();
  switch (normalised) {
    case "none":
    case "hidden":
    case "solid":
    case "dashed":
    case "dotted":
    case "double":
    case "groove":
    case "ridge":
    case "inset":
    case "outset":
      return normalised;
    default:
      return "solid";
  }
}

function toCssPosition(value: string): CssPosition {
  const normalised = value.trim().toLowerCase();
  switch (normalised) {
    case "relative":
    case "absolute":
    case "fixed":
    case "sticky":
    case "static":
      return normalised;
    default:
      return "static";
  }
}

function readStackingInput(id: string, style: StyleLike, parentDisplay: string): StackingInput {
  const get = (property: string): string => style.getPropertyValue(property);
  return {
    id,
    display: get("display"),
    position: get("position"),
    zIndex: get("z-index"),
    opacity: get("opacity"),
    transform: get("transform"),
    filter: get("filter"),
    backdropFilter: get("backdrop-filter"),
    mixBlendMode: get("mix-blend-mode"),
    isolation: get("isolation"),
    willChange: get("will-change"),
    contain: get("contain"),
    clipPath: get("clip-path"),
    mask: get("mask"),
    perspective: get("perspective"),
    float: get("float"),
    parentDisplay,
    children: [],
  };
}

function readStroke(style: StyleLike, reasons: string[]): Stroke | undefined {
  const widths: number[] = [];
  const colors: Array<{ r: number; g: number; b: number; a: number }> = [];
  const styles: BorderStyle[] = [];

  for (const side of BORDER_SIDES) {
    const style_ = toBorderStyle(style.getPropertyValue(`border-${side}-style`));
    const width = parseLength(style.getPropertyValue(`border-${side}-width`)) ?? 0;
    const colorResult = parseColorDetailed(style.getPropertyValue(`border-${side}-color`));
    reasons.push(...colorResult.reasons);

    // `none` and `hidden` force the used width to zero regardless of the
    // declared width.
    const usedWidth = style_ === "none" || style_ === "hidden" ? 0 : width;
    widths.push(round(Math.max(usedWidth, 0)));
    colors.push(colorResult.color ?? { r: 0, g: 0, b: 0, a: 0 });
    styles.push(style_);
  }

  if (widths.every((width) => width === 0)) return undefined;

  // The dominant side is the widest visible one; it supplies the scalar
  // colour/style, with the per-side arrays kept when the sides disagree.
  let dominant = 0;
  for (let i = 1; i < widths.length; i += 1) {
    if ((widths[i] ?? 0) > (widths[dominant] ?? 0)) dominant = i;
  }

  const quadWidths = widths as [number, number, number, number];
  const quadColors = colors as [
    (typeof colors)[0],
    (typeof colors)[0],
    (typeof colors)[0],
    (typeof colors)[0],
  ];
  const quadStyles = styles as [BorderStyle, BorderStyle, BorderStyle, BorderStyle];

  const stroke: Stroke = {
    widths: quadWidths,
    color: quadColors[dominant] ?? { r: 0, g: 0, b: 0, a: 0 },
    style: quadStyles[dominant] ?? "solid",
  };

  const uniformWidth = quadWidths.every((width) => width === quadWidths[0]);
  if (!uniformWidth) reasons.push("border-widths-differ");

  const colorKey = (index: number): string => {
    const color = quadColors[index];
    return color === undefined ? "" : `${color.r},${color.g},${color.b},${color.a}`;
  };
  if ([1, 2, 3].some((index) => colorKey(index) !== colorKey(0))) {
    stroke.colors = quadColors;
  }
  if (quadStyles.some((value) => value !== quadStyles[0])) {
    stroke.styles = quadStyles;
  }
  if (quadStyles.some((value) => value === "groove" || value === "ridge" || value === "double")) {
    reasons.push("border-style-approximated");
  }

  return stroke;
}

function readFill(
  style: StyleLike,
  frame: Frame,
  reasons: string[],
): { fill: Paint | undefined; gradientUsed: boolean } {
  const backgroundColor = parseColorDetailed(style.getPropertyValue("background-color"));
  reasons.push(...backgroundColor.reasons);

  const backgroundImage = style.getPropertyValue("background-image");
  const layers = backgroundLayerCount(backgroundImage);
  if (layers > 1) reasons.push("multiple-backgrounds");

  // Layers paint front-to-back, so the first one is the one that shows.
  const topLayer = splitTopLevel(backgroundImage, ",")[0] ?? "";
  if (isGradient(topLayer)) {
    const gradient = parseGradient(topLayer, { w: frame.w, h: frame.h });
    reasons.push(...gradient.reasons);
    if (gradient.paint !== null) {
      if (!isTransparent(backgroundColor.color)) reasons.push("background-color-behind-gradient");
      return { fill: gradient.paint, gradientUsed: true };
    }
  }

  if (!isTransparent(backgroundColor.color) && backgroundColor.color !== null) {
    return { fill: { kind: "solid", color: backgroundColor.color }, gradientUsed: false };
  }
  return { fill: undefined, gradientUsed: false };
}

function readClip(style: StyleLike): boolean {
  const clipping = new Set(["hidden", "scroll", "auto", "clip", "overlay"]);
  return (
    clipping.has(style.getPropertyValue("overflow-x").trim().toLowerCase()) ||
    clipping.has(style.getPropertyValue("overflow-y").trim().toLowerCase())
  );
}

function hasVisiblePaint(node: SceneNode): boolean {
  return (
    node.paint.fill !== undefined ||
    node.paint.stroke !== undefined ||
    (node.paint.shadows !== undefined && node.paint.shadows.length > 0) ||
    node.assetId !== undefined ||
    node.text !== undefined
  );
}

class Walker {
  private readonly collector = new AssetCollector();
  private readonly log = new CaptureLog();
  private readonly fonts = new Map<string, FontRef>();

  constructor(
    private readonly env: CaptureEnv,
    private readonly options: CaptureOptions,
  ) {}

  run(): WalkResult {
    const built = this.visit(this.env.root, [], 1, "block");

    const root: SceneNode = built?.node ??
      // A capture root that is itself skipped still needs a document root, or
      // the scene would have nothing to hang the artboard off.
      {
        id: "root",
        name: nodeName(this.env.root),
        role: "box",
        frame: { x: 0, y: 0, w: this.env.documentSize.w, h: this.env.documentSize.h },
        paint: { radius: [0, 0, 0, 0], opacity: 1 },
        clip: false,
        stackingOrder: 0,
        children: [],
        unsupportedReasons: ["capture-root-skipped"],
      };

    if (built === null) this.log.unsupported("capture-root-skipped", root.name);

    if (built !== null) {
      const order = paintOrderIndex(built.stack);
      this.applyPaintOrder(built.node, order, order.size);
    }

    const documentSize = this.options.fullPage
      ? this.env.documentSize
      : { w: this.env.viewport.w, h: this.env.viewport.h };

    const scene: Scene = {
      version: 1,
      source: {
        url: this.env.url,
        title: this.env.title,
        capturedAt: this.env.capturedAt,
        viewport: {
          w: round(this.env.viewport.w),
          h: round(this.env.viewport.h),
          dpr: this.env.viewport.dpr,
        },
        document: { w: round(documentSize.w), h: round(documentSize.h) },
      },
      options: this.options,
      fonts: [...this.fonts.values()],
      assets: [],
      root,
    };

    return { scene, assetRequests: this.collector.requests(), log: this.log };
  }

  /**
   * Writes the resolved paint index onto every node and re-orders siblings
   * back-to-front. Nodes the resolver never saw (they cannot occur for real
   * input, but the tree and the stacking tree are built separately) are pushed
   * to the front rather than silently collapsing to 0.
   */
  private applyPaintOrder(node: SceneNode, order: Map<string, number>, fallbackBase: number): void {
    const index = order.get(node.id);
    node.stackingOrder = index ?? fallbackBase;

    for (const child of node.children) this.applyPaintOrder(child, order, fallbackBase);

    node.children.sort((a, b) => a.stackingOrder - b.stackingOrder);

    const names = deduplicateNames(node.children.map((child) => child.name));
    node.children.forEach((child, position) => {
      child.name = names[position] ?? child.name;
    });
  }

  private frameFor(rect: RectLike): Frame {
    return {
      x: round(rect.x + this.env.scroll.x),
      y: round(rect.y + this.env.scroll.y),
      w: round(Math.max(rect.width, 0)),
      h: round(Math.max(rect.height, 0)),
    };
  }

  private outsideViewport(frame: Frame): boolean {
    if (this.options.fullPage) return false;
    const { w, h } = this.env.viewport;
    return frame.x + frame.w <= 0 || frame.y + frame.h <= 0 || frame.x >= w || frame.y >= h;
  }

  private shouldSkip(element: DomElementLike, style: StyleLike, name: string): boolean {
    const tag = tagNameOf(element);
    if (NEVER_WALK.has(tag)) return true;

    for (const selector of this.options.skipSelectors) {
      try {
        if (element.matches(selector)) {
          this.log.info("skipped-by-selector", name, selector);
          return true;
        }
      } catch {
        this.log.warn("skip-selector-invalid", name, selector);
      }
    }

    if (style.getPropertyValue("display").trim().toLowerCase() === "none") return true;

    const visibility = style.getPropertyValue("visibility").trim().toLowerCase();
    if (visibility === "hidden" || visibility === "collapse") return true;

    const opacity = Number(style.getPropertyValue("opacity"));
    if (Number.isFinite(opacity) && opacity === 0) return true;

    return false;
  }

  private recordFonts(node: SceneNode): void {
    if (node.text === undefined) return;
    for (const run of node.text.runs) {
      const key = `${run.font.family}|${run.font.weight}|${run.font.style}`;
      if (!this.fonts.has(key)) this.fonts.set(key, run.font);
    }
  }

  private visit(
    element: DomElementLike,
    path: readonly number[],
    depth: number,
    parentDisplay: string,
  ): Built | null {
    const style = this.env.getComputedStyle(element);
    const name = nodeName(element);
    if (this.shouldSkip(element, style, name)) return null;

    const rect = this.env.getRect(element);
    const frame = this.frameFor(rect);
    if (this.outsideViewport(frame)) return null;

    const tag = tagNameOf(element);
    const id = nodeId(path, `${tag}:${path.length}`);
    const reasons: string[] = [];

    const radius = parseBorderRadius(
      {
        topLeft: style.getPropertyValue("border-top-left-radius"),
        topRight: style.getPropertyValue("border-top-right-radius"),
        bottomRight: style.getPropertyValue("border-bottom-right-radius"),
        bottomLeft: style.getPropertyValue("border-bottom-left-radius"),
      },
      { w: frame.w, h: frame.h },
    );
    reasons.push(...radius.reasons);

    const { fill } = readFill(style, frame, reasons);
    const stroke = readStroke(style, reasons);
    const shadow = parseBoxShadow(style.getPropertyValue("box-shadow"));
    reasons.push(...shadow.reasons);

    const opacityValue = Number(style.getPropertyValue("opacity"));
    const paint: NodePaint = {
      radius: radius.radius,
      opacity: Number.isFinite(opacityValue) ? clamp(opacityValue, 0, 1) : 1,
    };
    if (fill !== undefined) paint.fill = fill;
    if (stroke !== undefined) paint.stroke = stroke;
    if (shadow.shadows.length > 0) paint.shadows = shadow.shadows;

    const blendMode = style.getPropertyValue("mix-blend-mode").trim().toLowerCase();
    if (blendMode !== "" && blendMode !== "normal") {
      paint.blendMode = blendMode;
      reasons.push("blend-mode-approximated");
    }

    const filter = style.getPropertyValue("filter").trim().toLowerCase();
    if (filter !== "" && filter !== "none") reasons.push("css-filter");
    const backdropFilter = style.getPropertyValue("backdrop-filter").trim().toLowerCase();
    if (backdropFilter !== "" && backdropFilter !== "none") reasons.push("backdrop-filter");
    const clipPath = style.getPropertyValue("clip-path").trim().toLowerCase();
    if (clipPath !== "" && clipPath !== "none") reasons.push("css-clip-path");

    const node: SceneNode = {
      id,
      name,
      role: "box",
      frame,
      paint,
      clip: readClip(style),
      stackingOrder: 0,
      children: [],
    };

    const cssPosition = toCssPosition(style.getPropertyValue("position"));
    if (cssPosition !== "static") node.cssPosition = cssPosition;

    const transform = parseTransform(style.getPropertyValue("transform"), {
      w: frame.w,
      h: frame.h,
    });
    reasons.push(...transform.reasons);
    if (transform.matrix !== null) {
      node.transform = transform.matrix;
      const origin = parseTransformOrigin(style.getPropertyValue("transform-origin"), {
        w: frame.w,
        h: frame.h,
      });
      if (origin !== null) node.transformOrigin = origin;
      // getBoundingClientRect already reflects the transform, so `frame` is the
      // *transformed* axis-aligned bounding box. The matrix travels as metadata
      // and must not be applied again; rotation and skew are lost.
      const isTranslationOnly =
        transform.matrix[0] === 1 &&
        transform.matrix[1] === 0 &&
        transform.matrix[2] === 0 &&
        transform.matrix[3] === 1;
      if (!isTranslationOnly) reasons.push("transform-baked-into-bounds");
    }

    const stack = readStackingInput(id, style, parentDisplay);
    const built: Built = { node, stack };

    const opaqueReason = OPAQUE_ELEMENTS[tag];
    if (opaqueReason !== undefined) {
      node.role = "unsupported";
      reasons.push(opaqueReason);
      this.finish(node, reasons);
      return built;
    }

    if (this.assignAsset(element, style, node, frame, reasons)) {
      this.finish(node, reasons);
      return built;
    }

    if (depth >= this.options.maxDepth) {
      reasons.push("max-depth-reached");
      this.finish(node, reasons);
      return built;
    }

    const textResult = extractText(element, style, this.env, { h: frame.h });
    if (textResult !== null) {
      node.role = "text";
      node.text = textResult.text;
      reasons.push(...textResult.reasons);
      if (this.options.capturePseudoElements) {
        this.mergePseudoText(element, node.text, reasons);
      }
      this.recordFonts(node);
      this.finish(node, reasons);
      return built;
    }

    if (!LEAF_ELEMENTS.has(tag)) {
      this.visitChildren(element, node, stack, path, depth, style);
    }
    if (this.options.capturePseudoElements) {
      this.visitPseudoElements(element, style, node, stack, frame, name);
    }

    this.finish(node, reasons);
    return built;
  }

  private visitChildren(
    element: DomElementLike,
    node: SceneNode,
    stack: StackingInput,
    path: readonly number[],
    depth: number,
    style: StyleLike,
  ): void {
    if (element.getAttribute("data-web2ai-ignore") !== null) {
      this.log.info("skipped-by-attribute", node.name);
      return;
    }

    const display = style.getPropertyValue("display");
    const children = childElementsOf(element);

    children.forEach((child, index) => {
      let childBuilt: Built | null = null;
      try {
        childBuilt = this.visit(child, [...path, index], depth + 1, display);
      } catch (error) {
        // One bad element must never take the capture down with it.
        this.log.warn(
          "node-capture-failed",
          nodeName(child),
          error instanceof Error ? error.message : String(error),
        );
        return;
      }
      if (childBuilt === null) return;
      node.children.push(childBuilt.node);
      stack.children.push(childBuilt.stack);
    });
  }

  /**
   * Folds a text element's `::before` / `::after` into its runs.
   *
   * On a text element the pseudo content is rendered *inline* with the text —
   * `.footer::before { content: "— " }` prints an em dash in front of the
   * footer's own words. Emitting it as a separate node would place a second
   * text frame on top of the first, because a pseudo-element has no geometry
   * of its own. Merging keeps one text frame with the characters in the right
   * order and the pseudo-element's own font and colour.
   */
  private mergePseudoText(element: DomElementLike, text: TextContent, reasons: string[]): void {
    for (const pseudo of ["::before", "::after"] as const) {
      let style: StyleLike;
      try {
        style = this.env.getComputedStyle(element, pseudo);
      } catch {
        continue;
      }

      const content = style.getPropertyValue("content").trim();
      if (content === "" || content === "none" || content === "normal") continue;

      if (!/^["']/.test(content)) {
        reasons.push(`pseudo-element-content-unsupported:${content.split("(")[0] ?? content}`);
        continue;
      }

      const run = pseudoRun(style, stripQuotes(content), this.env);
      if (run === null) continue;

      if (pseudo === "::before") text.runs.unshift(run);
      else text.runs.push(run);
      reasons.push("pseudo-element-merged-into-text");
    }
  }

  /**
   * Emits `::before` / `::after` as nodes.
   *
   * `getComputedStyle(el, "::before")` returns style but no geometry —
   * pseudo-elements have no box in the DOM API — so they inherit the parent's
   * frame and say so. Only pseudo-elements that actually paint are emitted;
   * the ubiquitous empty clearfix `::after` is dropped.
   */
  private visitPseudoElements(
    element: DomElementLike,
    parentStyle: StyleLike,
    node: SceneNode,
    stack: StackingInput,
    frame: Frame,
    parentName: string,
  ): void {
    for (const pseudo of ["::before", "::after"] as const) {
      let style: StyleLike;
      try {
        style = this.env.getComputedStyle(element, pseudo);
      } catch {
        continue;
      }

      const content = style.getPropertyValue("content").trim();
      if (content === "" || content === "none" || content === "normal") continue;

      const reasons = ["pseudo-element-geometry-approximated"];
      const pseudoId = `${node.id}${pseudo}`;
      const pseudoFrame: Frame = { ...frame };

      const { fill } = readFill(style, pseudoFrame, reasons);
      const stroke = readStroke(style, reasons);

      let textChars: string | null = null;
      if (/^["']/.test(content)) {
        const unquoted = stripQuotes(content);
        if (unquoted.length > 0) textChars = unquoted;
      } else if (content.startsWith("url(")) {
        // Handled below via readFill's asset path is not applicable; report it.
        reasons.push("pseudo-element-image-unsupported");
      } else {
        reasons.push(`pseudo-element-content-unsupported:${content.split("(")[0] ?? content}`);
      }

      const paints = fill !== undefined || stroke !== undefined || textChars !== null;
      if (!paints) continue;

      const paint: NodePaint = { radius: [0, 0, 0, 0], opacity: 1 };
      if (fill !== undefined) paint.fill = fill;
      if (stroke !== undefined) paint.stroke = stroke;

      const pseudoNode: SceneNode = {
        id: pseudoId,
        name: `${parentName}${pseudo}`,
        role: textChars === null ? "box" : "text",
        frame: pseudoFrame,
        paint,
        clip: false,
        stackingOrder: 0,
        children: [],
        unsupportedReasons: reasons,
      };

      if (textChars !== null) {
        const run = pseudoRun(style, textChars, this.env);
        if (run === null) {
          pseudoNode.role = "box";
        } else {
          pseudoNode.text = {
            runs: [run],
            isSingleLine: run.lineHeight > 0 && pseudoFrame.h <= run.lineHeight * 1.5,
          };
          this.recordFonts(pseudoNode);
        }
      }

      this.log.addReasons(reasons, pseudoNode.name, "warn");

      // ::before paints before the element's other content, ::after after it.
      if (pseudo === "::before") {
        node.children.unshift(pseudoNode);
        stack.children.unshift(
          readStackingInput(pseudoId, style, parentStyle.getPropertyValue("display")),
        );
      } else {
        node.children.push(pseudoNode);
        stack.children.push(
          readStackingInput(pseudoId, style, parentStyle.getPropertyValue("display")),
        );
      }
    }
  }

  /** Returns true when the element is an image-like leaf and was handled. */
  private assignAsset(
    element: DomElementLike,
    style: StyleLike,
    node: SceneNode,
    frame: Frame,
    reasons: string[],
  ): boolean {
    const tag = tagNameOf(element);

    if (tag === "img") {
      const info = this.env.imageInfo(element);
      if (info === null || info.src === "") {
        reasons.push("image-source-missing");
        node.role = "unsupported";
        return true;
      }
      node.role = "image";
      node.assetId = this.collector.addUrl(
        this.env.resolveUrl(info.src),
        "raster",
        info.width,
        info.height,
      );
      return true;
    }

    if (tag === "svg" && isSvgElement(element)) {
      const source = this.env.svgSource(element);
      if (source === null) {
        reasons.push("svg-source-unavailable");
        node.role = "unsupported";
        return true;
      }
      node.role = "svg";
      node.assetId = this.collector.addInline("image/svg+xml", source, "svg", frame.w, frame.h);
      return true;
    }

    if (tag === "canvas") {
      if (!this.options.captureCanvas) {
        reasons.push("canvas-capture-disabled");
        node.role = "unsupported";
        return true;
      }
      const captured = this.env.canvasDataUrl(element);
      if (captured === null || "error" in captured) {
        reasons.push(captured === null ? "canvas-unavailable" : captured.error);
        node.role = "unsupported";
        return true;
      }
      node.role = "image";
      node.assetId = this.collector.addInline(
        "image/png",
        captured.dataUrl,
        "raster",
        frame.w,
        frame.h,
      );
      return true;
    }

    // `background-image: url(...)` on any element.
    const urls = backgroundImageUrls(style.getPropertyValue("background-image"));
    const first = urls[0];
    if (first !== undefined) {
      node.assetId = this.collector.addUrl(this.env.resolveUrl(first), "raster", 0, 0);
      reasons.push("background-positioning-ignored");
      // Only a leaf becomes an image node; a container keeps its box role so
      // the layer hierarchy stays intact.
      if (childElementsOf(element).length === 0) node.role = "image";
    }

    return false;
  }

  private finish(node: SceneNode, reasons: readonly string[]): void {
    const unique = [...new Set(reasons)];
    if (unique.length > 0) {
      node.unsupportedReasons = unique;
      this.log.addReasons(unique, node.name, node.role === "unsupported" ? "unsupported" : "warn");
    }

    const area = node.frame.w * node.frame.h;
    if (node.children.length === 0 && !hasVisiblePaint(node) && node.role !== "unsupported") {
      this.log.info(
        area < this.options.minNodeArea ? "pruned-zero-area" : "pruned-empty-leaf",
        node.name,
      );
      node.role = "unsupported";
      node.unsupportedReasons = [...unique, "pruned-no-visible-paint"];
    }
  }
}

/**
 * Walks a DOM into a `ui-scene@1` document.
 *
 * Synchronous by design: assets are only *recorded* here and fetched in a
 * separate pass, which keeps the walker free of I/O and testable against a
 * synthetic DOM.
 */
export function walk(env: CaptureEnv, options: CaptureOptions): WalkResult {
  return new Walker(env, options).run();
}

/** Removes nodes that were pruned during the walk, keeping the tree tidy. */
export function dropPrunedNodes(node: SceneNode): SceneNode {
  const children = node.children
    .filter(
      (child) =>
        !(child.unsupportedReasons ?? []).includes("pruned-no-visible-paint") ||
        child.children.length > 0,
    )
    .map(dropPrunedNodes);
  return { ...node, children };
}
