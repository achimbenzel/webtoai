import type {
  CanvasCapture,
  CaptureEnv,
  DomElementLike,
  ImageInfo,
  RectLike,
  StyleLike,
} from "../lib/dom.ts";

/**
 * The real-DOM implementation of `CaptureEnv`.
 *
 * Everything browser-specific lives here — `currentSrc`, `XMLSerializer`,
 * `canvas.toDataURL`, `document.fonts` — so that `lib/` stays a pure,
 * testable core.
 */

/**
 * The DOM's `Element` satisfies `DomElementLike` structurally, except that
 * `nodeType` is typed as `number` rather than the literal `1`. These two
 * helpers are the only place that gap is bridged.
 */
function asDomElement(element: Element): DomElementLike {
  return element as unknown as DomElementLike;
}

function toElement(node: DomElementLike): Element {
  return node as unknown as Element;
}

/** Families declared by `@font-face` on the page, lower-cased. */
function collectWebFontFamilies(): Set<string> {
  const families = new Set<string>();
  try {
    document.fonts.forEach((face) => {
      families.add(face.family.replace(/^["']|["']$/g, "").toLowerCase());
    });
  } catch {
    // FontFaceSet iteration can throw in sandboxed documents; a missing entry
    // only means `isWebFont` is false, which the report can live with.
  }
  return families;
}

export class CaptureEnvError extends Error {}

export interface CreateEnvOptions {
  rootSelector: string;
  capturedAt: string;
}

export function createCaptureEnv(options: CreateEnvOptions): CaptureEnv {
  const selector = options.rootSelector.trim();
  let rootElement: Element | null = document.body;

  if (selector !== "") {
    try {
      rootElement = document.querySelector(selector);
    } catch {
      throw new CaptureEnvError(`Invalid root selector: ${selector}`);
    }
    if (rootElement === null) {
      throw new CaptureEnvError(`No element matches the root selector: ${selector}`);
    }
  }
  if (rootElement === null) {
    throw new CaptureEnvError("The document has no <body> to capture.");
  }

  const documentElement = document.documentElement;
  const webFontFamilies = collectWebFontFamilies();

  return {
    root: asDomElement(rootElement),

    getComputedStyle(element: DomElementLike, pseudo?: string | null): StyleLike {
      return window.getComputedStyle(toElement(element), pseudo ?? null);
    },

    getRect(element: DomElementLike): RectLike {
      return toElement(element).getBoundingClientRect();
    },

    scroll: { x: window.scrollX, y: window.scrollY },

    viewport: {
      w: documentElement.clientWidth,
      h: documentElement.clientHeight,
      dpr: window.devicePixelRatio,
    },

    documentSize: {
      w: Math.max(
        documentElement.scrollWidth,
        document.body.scrollWidth,
        documentElement.clientWidth,
      ),
      h: Math.max(
        documentElement.scrollHeight,
        document.body.scrollHeight,
        documentElement.clientHeight,
      ),
    },

    url: window.location.href,
    title: document.title,
    capturedAt: options.capturedAt,

    imageInfo(element: DomElementLike): ImageInfo | null {
      const real = toElement(element);
      if (!(real instanceof HTMLImageElement)) return null;
      return {
        // `currentSrc` is the source the browser actually picked out of
        // srcset/<picture>; `src` is only the authored fallback.
        src: real.currentSrc !== "" ? real.currentSrc : real.src,
        width: real.naturalWidth,
        height: real.naturalHeight,
      };
    },

    svgSource(element: DomElementLike): string | null {
      const real = toElement(element);
      if (!(real instanceof SVGSVGElement)) return null;
      try {
        return new XMLSerializer().serializeToString(real);
      } catch {
        return null;
      }
    },

    canvasDataUrl(element: DomElementLike): CanvasCapture | null {
      const real = toElement(element);
      if (!(real instanceof HTMLCanvasElement)) return null;
      try {
        return { dataUrl: real.toDataURL("image/png") };
      } catch {
        // Reading a canvas that has drawn cross-origin content throws a
        // SecurityError. There is no way around it, so it is reported.
        return { error: "canvas-tainted" };
      }
    },

    webFontFamilies,

    resolveUrl(url: string): string {
      try {
        return new URL(url, document.baseURI).href;
      } catch {
        return url;
      }
    },
  };
}
