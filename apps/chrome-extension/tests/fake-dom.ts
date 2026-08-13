import type {
  CanvasCapture,
  CaptureEnv,
  DomElementLike,
  DomNodeLike,
  DomTextLike,
  ImageInfo,
  RectLike,
  StyleLike,
} from "../src/lib/dom.ts";

/**
 * A synthetic DOM for walker tests.
 *
 * jsdom has no layout engine, so `getBoundingClientRect` there returns zeros
 * and every geometry assertion becomes meaningless. Since the walker is written
 * against the narrow `CaptureEnv` interface rather than the real DOM, tests can
 * instead state the layout explicitly — which is both faster and far more
 * legible than fighting a headless browser for a unit test.
 */

/** Every computed property the walker reads, with its CSS initial value. */
const DEFAULT_STYLE: Readonly<Record<string, string>> = {
  display: "block",
  position: "static",
  "z-index": "auto",
  opacity: "1",
  visibility: "visible",
  transform: "none",
  "transform-origin": "50% 50%",
  filter: "none",
  "backdrop-filter": "none",
  "mix-blend-mode": "normal",
  isolation: "auto",
  "will-change": "auto",
  contain: "none",
  "clip-path": "none",
  mask: "none",
  perspective: "none",
  float: "none",
  "overflow-x": "visible",
  "overflow-y": "visible",
  "background-color": "rgba(0, 0, 0, 0)",
  "background-image": "none",
  "box-shadow": "none",
  "border-top-width": "0px",
  "border-right-width": "0px",
  "border-bottom-width": "0px",
  "border-left-width": "0px",
  "border-top-style": "none",
  "border-right-style": "none",
  "border-bottom-style": "none",
  "border-left-style": "none",
  "border-top-color": "rgb(0, 0, 0)",
  "border-right-color": "rgb(0, 0, 0)",
  "border-bottom-color": "rgb(0, 0, 0)",
  "border-left-color": "rgb(0, 0, 0)",
  "border-top-left-radius": "0px",
  "border-top-right-radius": "0px",
  "border-bottom-right-radius": "0px",
  "border-bottom-left-radius": "0px",
  "font-family": "Arial",
  "font-size": "16px",
  "font-weight": "400",
  "font-style": "normal",
  color: "rgb(0, 0, 0)",
  "line-height": "normal",
  "letter-spacing": "normal",
  "text-align": "start",
  "text-decoration-line": "none",
  "text-transform": "none",
  "white-space": "normal",
  content: "none",
};

export interface FakeSpec {
  tag: string;
  id?: string;
  className?: string;
  attrs?: Record<string, string>;
  /** Computed style overrides, keyed by CSS property name. */
  style?: Record<string, string>;
  /** Border-box rect, viewport-relative. Defaults to a 100x20 box at 0,0. */
  rect?: Partial<RectLike>;
  /** Direct text content; makes this element a text node candidate. */
  text?: string;
  before?: Record<string, string>;
  after?: Record<string, string>;
  children?: FakeSpec[];
  /**
   * Interleaved text and elements, in document order — the shape `text` plus
   * `children` cannot express, because it always puts the text first.
   *
   * `<p>Als <span>freiberuflicher</span> Designer</p>` is the single most
   * common paragraph on the web and its whitespace is entirely carried by the
   * text nodes *between* the elements, so a harness that cannot build it
   * cannot test the thing most likely to be wrong.
   */
  content?: Array<string | FakeTextSpec | FakeSpec>;
  /** For `<img>`. */
  image?: ImageInfo;
  /** For `<svg>`. */
  svg?: string;
  /** For `<canvas>`. */
  canvas?: CanvasCapture;
}

class FakeStyle implements StyleLike {
  constructor(private readonly values: Record<string, string>) {}

  getPropertyValue(property: string): string {
    return this.values[property] ?? DEFAULT_STYLE[property] ?? "";
  }
}

/** A text node with the geometry a `Range` would report for it. */
export interface FakeTextSpec {
  data: string;
  /** Rect of the anonymous block box; null models a text node with no box. */
  rect?: Partial<RectLike> | null;
}

interface FakeText extends DomNodeLike {
  nodeType: 3;
  data: string;
  rect: RectLike | null;
}

function isTextSpec(part: string | FakeTextSpec | FakeSpec): part is FakeTextSpec {
  return typeof part !== "string" && "data" in part;
}

function makeText(data: string, rect?: Partial<RectLike> | null): FakeText {
  return {
    nodeType: 3,
    data,
    rect:
      rect === null
        ? null
        : {
            x: rect?.x ?? 0,
            y: rect?.y ?? 0,
            width: rect?.width ?? 100,
            height: rect?.height ?? 20,
          },
  };
}

export class FakeElement implements DomElementLike {
  readonly nodeType = 1 as const;
  readonly tagName: string;
  readonly namespaceURI: string | null;
  readonly childNodes: DomNodeLike[] = [];

  readonly style: FakeStyle;
  readonly beforeStyle: FakeStyle | null;
  readonly afterStyle: FakeStyle | null;
  readonly rect: RectLike;
  readonly spec: FakeSpec;

  private readonly attributes: Record<string, string>;

  constructor(spec: FakeSpec) {
    this.spec = spec;
    this.tagName = spec.tag.toUpperCase();
    this.namespaceURI =
      spec.tag === "svg" || spec.tag === "path" || spec.tag === "circle"
        ? "http://www.w3.org/2000/svg"
        : "http://www.w3.org/1999/xhtml";

    this.attributes = { ...spec.attrs };
    if (spec.id !== undefined) this.attributes["id"] = spec.id;
    if (spec.className !== undefined) this.attributes["class"] = spec.className;

    this.style = new FakeStyle(spec.style ?? {});
    this.beforeStyle = spec.before === undefined ? null : new FakeStyle(spec.before);
    this.afterStyle = spec.after === undefined ? null : new FakeStyle(spec.after);

    this.rect = {
      x: spec.rect?.x ?? 0,
      y: spec.rect?.y ?? 0,
      width: spec.rect?.width ?? 100,
      height: spec.rect?.height ?? 20,
    };

    if (spec.text !== undefined) {
      this.childNodes.push(makeText(spec.text));
    }
    for (const child of spec.children ?? []) {
      this.childNodes.push(new FakeElement(child));
    }
    for (const part of spec.content ?? []) {
      if (typeof part === "string") this.childNodes.push(makeText(part));
      else if (isTextSpec(part)) this.childNodes.push(makeText(part.data, part.rect));
      else this.childNodes.push(new FakeElement(part));
    }
  }

  getAttribute(name: string): string | null {
    return this.attributes[name] ?? null;
  }

  /** Supports the selector shapes that appear in `skipSelectors`. */
  matches(selector: string): boolean {
    return selector.split(",").some((part) => {
      const token = part.trim();
      if (token === "") return false;
      if (token.startsWith("#")) return this.getAttribute("id") === token.slice(1);
      if (token.startsWith(".")) {
        const classes = (this.getAttribute("class") ?? "").split(/\s+/);
        return classes.includes(token.slice(1));
      }
      if (token.startsWith("[") && token.endsWith("]")) {
        return this.getAttribute(token.slice(1, -1)) !== null;
      }
      return token.toLowerCase() === this.tagName.toLowerCase();
    });
  }
}

export interface FakeEnvOptions {
  scroll?: { x: number; y: number };
  viewport?: { w: number; h: number; dpr: number };
  documentSize?: { w: number; h: number };
  url?: string;
  title?: string;
  capturedAt?: string;
  webFontFamilies?: string[];
}

export function createFakeEnv(spec: FakeSpec, options: FakeEnvOptions = {}): CaptureEnv {
  const root = new FakeElement(spec);

  const asFake = (element: DomElementLike): FakeElement => {
    if (!(element instanceof FakeElement)) {
      throw new Error(`Expected a FakeElement, received ${String(element.tagName)}`);
    }
    return element;
  };

  return {
    root,

    getComputedStyle(element: DomElementLike, pseudo?: string | null): StyleLike {
      const fake = asFake(element);
      if (pseudo === "::before") return fake.beforeStyle ?? new FakeStyle({});
      if (pseudo === "::after") return fake.afterStyle ?? new FakeStyle({});
      return fake.style;
    },

    getRect(element: DomElementLike): RectLike {
      return asFake(element).rect;
    },

    getTextRect(node: DomTextLike): RectLike | null {
      return (node as unknown as FakeText).rect;
    },

    scroll: options.scroll ?? { x: 0, y: 0 },
    viewport: options.viewport ?? { w: 1280, h: 800, dpr: 1 },
    documentSize: options.documentSize ?? { w: 1280, h: 2000 },
    url: options.url ?? "https://example.test/",
    title: options.title ?? "Fixture",
    capturedAt: options.capturedAt ?? "2026-01-01T00:00:00.000Z",

    imageInfo(element: DomElementLike): ImageInfo | null {
      return asFake(element).spec.image ?? null;
    },

    svgSource(element: DomElementLike): string | null {
      return asFake(element).spec.svg ?? null;
    },

    canvasDataUrl(element: DomElementLike): CanvasCapture | null {
      return asFake(element).spec.canvas ?? null;
    },

    webFontFamilies: new Set(options.webFontFamilies ?? []),

    resolveUrl(url: string): string {
      try {
        return new URL(url, options.url ?? "https://example.test/").href;
      } catch {
        return url;
      }
    },
  };
}
