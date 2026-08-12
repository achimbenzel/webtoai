/**
 * The narrow view of the DOM that the capture logic is written against.
 *
 * The walker never touches `window`, `document` or the real `Element` type. It
 * talks to these structural interfaces instead, which buys two things:
 *
 *  - the walker is testable with a synthetic tree, in Node, with no browser
 *    and no layout engine;
 *  - everything browser-specific (`currentSrc`, `toDataURL`, `document.fonts`)
 *    is confined to the content-script adapter in `src/content/env.ts`.
 */

export const NODE_TYPE_ELEMENT = 1;
export const NODE_TYPE_TEXT = 3;

export interface DomNodeLike {
  readonly nodeType: number;
}

export interface DomTextLike extends DomNodeLike {
  readonly nodeType: 3;
  readonly data: string;
}

export interface DomElementLike extends DomNodeLike {
  readonly nodeType: 1;
  /** Upper-case for HTML elements, as the DOM specifies. */
  readonly tagName: string;
  readonly namespaceURI: string | null;
  readonly childNodes: ArrayLike<DomNodeLike>;
  getAttribute(name: string): string | null;
  matches(selector: string): boolean;
}

export function isElement(node: DomNodeLike): node is DomElementLike {
  return node.nodeType === NODE_TYPE_ELEMENT;
}

export function isText(node: DomNodeLike): node is DomTextLike {
  return node.nodeType === NODE_TYPE_TEXT;
}

export function childNodesOf(element: DomElementLike): DomNodeLike[] {
  return Array.from({ length: element.childNodes.length }, (_unused, index) => {
    const child = element.childNodes[index];
    if (child === undefined) throw new Error("childNodes index out of range");
    return child;
  });
}

export function childElementsOf(element: DomElementLike): DomElementLike[] {
  return childNodesOf(element).filter(isElement);
}

/** Just enough of `CSSStyleDeclaration` to read computed values. */
export interface StyleLike {
  getPropertyValue(property: string): string;
}

/** Viewport-relative rectangle, matching `getBoundingClientRect`. */
export interface RectLike {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface ImageInfo {
  /** The source actually chosen by the browser (`currentSrc`), absolute. */
  src: string;
  /** Intrinsic size in CSS px; 0 when the image has not loaded. */
  width: number;
  height: number;
}

export type CanvasCapture = { dataUrl: string } | { error: string };

/**
 * Everything the walker needs from the outside world.
 *
 * Implemented for real by `src/content/env.ts` and by hand in the tests.
 */
export interface CaptureEnv {
  /** The element the capture starts from. */
  readonly root: DomElementLike;
  /** Computed style; `pseudo` is `"::before"` / `"::after"` or null. */
  getComputedStyle(element: DomElementLike, pseudo?: string | null): StyleLike;
  /** Border-box rectangle, viewport-relative. */
  getRect(element: DomElementLike): RectLike;
  /** Scroll offset at capture time, added to rects to get document space. */
  readonly scroll: { x: number; y: number };
  readonly viewport: { w: number; h: number; dpr: number };
  /** Full scrollable document size in CSS px. */
  readonly documentSize: { w: number; h: number };
  readonly url: string;
  readonly title: string;
  /** ISO timestamp; injected so snapshots are deterministic. */
  readonly capturedAt: string;
  /** `<img>` source and intrinsic size, or null for other elements. */
  imageInfo(element: DomElementLike): ImageInfo | null;
  /** Serialised source of an inline `<svg>` root, or null. */
  svgSource(element: DomElementLike): string | null;
  /** `<canvas>` contents, or null for other elements. */
  canvasDataUrl(element: DomElementLike): CanvasCapture | null;
  /** Lower-cased families declared by `@font-face` on the page. */
  readonly webFontFamilies: ReadonlySet<string>;
  /** Resolves a possibly relative URL against the document. */
  resolveUrl(url: string): string;
}

/** Lower-case tag name, namespace-independent. */
export function tagNameOf(element: DomElementLike): string {
  return element.tagName.toLowerCase();
}

export function isSvgElement(element: DomElementLike): boolean {
  return element.namespaceURI === "http://www.w3.org/2000/svg";
}
