/**
 * ui-scene@1 — the intermediate format exchanged between the Chrome capture
 * side and the Illustrator render side.
 *
 * Coordinate system
 * -----------------
 * All coordinates and sizes are in **document space, CSS pixels**, origin at
 * the top-left of the captured document, y growing *downwards* (i.e. plain DOM
 * semantics). The Illustrator side is solely responsible for converting to
 * Illustrator's artboard space, where y grows upwards:
 *
 *     x_ai = x_dom
 *     y_ai = -y_dom
 *
 * Units: 1 CSS px is emitted as 1 point. That is exact only under the classic
 * 72 dpi assumption (1 pt = 1/72 in) combined with the CSS reference pixel at
 * 96 dpi — meaning a captured 100 px box becomes a 100 pt box, which is 1.333x
 * larger in physical terms. We keep 1:1 deliberately so that numbers stay
 * readable and round-trip; see docs/ARCHITECTURE.md ("Units").
 *
 * Paint order
 * -----------
 * `children` is ordered **back-to-front** (painter's order): `children[0]` is
 * painted first and therefore sits visually *behind* `children[n]`. Illustrator
 * layer palettes are the other way round (`layers[0]` is topmost), so the
 * renderer inserts children in reverse. `stackingOrder` is a globally unique,
 * monotonically increasing index over the whole scene in true CSS paint order —
 * it is *not* DOM order.
 */

/** sRGB colour. r/g/b are 0-255 integers, a is 0-1. */
export interface RGBA {
  r: number;
  g: number;
  b: number;
  a: number;
}

export type FontStyle = "normal" | "italic" | "oblique";

export interface FontRef {
  /** First family of the CSS `font-family` list, unquoted. */
  family: string;
  /** Numeric weight 1-1000; CSS keywords are already resolved. */
  weight: number;
  style: FontStyle;
  /** True when the family is provided by an @font-face rule on the page. */
  isWebFont: boolean;
  /** Full CSS `font-family` stack, kept so the host can try later entries. */
  stack?: string;
}

export interface GradientStop {
  color: RGBA;
  /** 0-1 along the gradient line. */
  offset: number;
}

export type Paint =
  | { kind: "solid"; color: RGBA }
  | {
      kind: "linear-gradient";
      /** CSS gradient angle in degrees: 0 = to top, 90 = to right. */
      angle: number;
      stops: GradientStop[];
    }
  | {
      kind: "radial-gradient";
      shape: "circle" | "ellipse";
      /** Centre as a fraction of the node's frame (0-1, may fall outside). */
      center: { x: number; y: number };
      /** Radii as a fraction of the node's frame. */
      radius: { x: number; y: number };
      stops: GradientStop[];
    };

export interface Shadow {
  inset: boolean;
  offsetX: number;
  offsetY: number;
  blur: number;
  spread: number;
  color: RGBA;
}

export type BorderStyle =
  | "none"
  | "hidden"
  | "solid"
  | "dashed"
  | "dotted"
  | "double"
  | "groove"
  | "ridge"
  | "inset"
  | "outset";

/** Top, right, bottom, left — CSS shorthand order throughout the schema. */
export type Quad = [number, number, number, number];

export interface Stroke {
  widths: Quad;
  /** Dominant colour (the colour of the widest visible side). */
  color: RGBA;
  /** Dominant style. */
  style: BorderStyle;
  /** Per-side colours; present when the sides differ. Extension of the base spec. */
  colors?: [RGBA, RGBA, RGBA, RGBA];
  /** Per-side styles; present when the sides differ. Extension of the base spec. */
  styles?: [BorderStyle, BorderStyle, BorderStyle, BorderStyle];
}

export interface NodePaint {
  fill?: Paint;
  stroke?: Stroke;
  /** top-left, top-right, bottom-right, bottom-left — CSS corner order. */
  radius: Quad;
  shadows?: Shadow[];
  /** 0-1. */
  opacity: number;
  blendMode?: string;
}

export type TextAlign = "left" | "right" | "center" | "justify" | "start" | "end";
export type TextDecoration = "none" | "underline" | "line-through" | "overline";

export interface TextRun {
  chars: string;
  font: FontRef;
  /** Font size in CSS px. */
  size: number;
  color: RGBA;
  /** Resolved line height in CSS px (`normal` is resolved to size * 1.2). */
  lineHeight: number;
  /** In CSS px; `normal` is resolved to 0. */
  letterSpacing: number;
  align: TextAlign;
  decoration?: TextDecoration;
}

export interface TextContent {
  runs: TextRun[];
  /** True when the text is known to occupy exactly one rendered line. */
  isSingleLine: boolean;
}

export type AssetKind = "raster" | "svg";

export interface Asset {
  id: string;
  kind: AssetKind;
  /** e.g. `image/png`, `image/svg+xml`. */
  mime: string;
  /** Original URL when known. Absent for inline `<svg>` and `<canvas>`. */
  src?: string;
  /** `data:` URL, present when the asset was embedded. */
  dataUrl?: string;
  /** Raw SVG source for inline `<svg>` elements. */
  svg?: string;
  /** Intrinsic size in CSS px; 0 when it could not be determined. */
  width: number;
  height: number;
  /** Set when the bytes could not be obtained; the node degrades to a box. */
  error?: string;
}

export type NodeRole = "box" | "text" | "image" | "svg" | "unsupported";

export type CssPosition = "static" | "relative" | "absolute" | "fixed" | "sticky";

export interface Frame {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface SceneNode {
  /** Deterministic hash of the node's DOM path — stable across captures. */
  id: string;
  /** Human readable, becomes the Illustrator layer/group name: `div#header.nav`. */
  name: string;
  role: NodeRole;
  /** Absolute border-box rectangle in document space. */
  frame: Frame;
  paint: NodePaint;
  text?: TextContent;
  assetId?: string;
  /** `overflow: hidden|scroll|auto` — the renderer builds a clipping mask. */
  clip: boolean;
  /** 2D affine matrix [a, b, c, d, e, f]; absent when identity. */
  transform?: number[];
  /** Transform origin relative to the node's frame, in CSS px. Extension of the base spec. */
  transformOrigin?: { x: number; y: number };
  /** CSS `position`, kept for reporting and for fixed/sticky handling. Extension of the base spec. */
  cssPosition?: CssPosition;
  /** Globally unique index in resolved paint order (low = painted first = behind). */
  stackingOrder: number;
  /** Machine readable reasons why this node is degraded; drives the import report. */
  unsupportedReasons?: string[];
  /** Back-to-front. */
  children: SceneNode[];
}

export interface CaptureOptions {
  /** Whole document vs. current viewport only. */
  fullPage: boolean;
  /** CSS selector used as the capture root; empty means `document.body`. */
  rootSelector: string;
  /** Ask the renderer to convert text to outlines. */
  textAsOutlines: boolean;
  /** Embed image bytes as data URLs instead of referencing the origin URL. */
  embedImages: boolean;
  /** Maximum DOM depth to descend; deeper nodes are marked unsupported. */
  maxDepth: number;
  /** Nodes smaller than this many square px are skipped. */
  minNodeArea: number;
  /** Elements matching any of these selectors are skipped entirely. */
  skipSelectors: string[];
  capturePseudoElements: boolean;
  captureCanvas: boolean;
}

export interface SceneSource {
  url: string;
  title: string;
  /** ISO-8601. */
  capturedAt: string;
  viewport: { w: number; h: number; dpr: number };
  /** Full scrollable document size in CSS px; the artboard is built from this. */
  document: { w: number; h: number };
}

export interface Scene {
  version: 1;
  source: SceneSource;
  options: CaptureOptions;
  fonts: FontRef[];
  assets: Asset[];
  root: SceneNode;
}

/** Emitted by the capture side, resolved by the background service worker. */
export interface AssetRequest {
  id: string;
  kind: AssetKind;
  /** Absolute URL to fetch, or undefined when `inline` carries the payload. */
  url?: string;
  /** Already-available payload: inline SVG source or a canvas data URL. */
  inline?: { mime: string; data: string };
  width: number;
  height: number;
}
