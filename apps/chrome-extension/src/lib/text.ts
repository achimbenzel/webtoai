import type { FontRef, TextAlign, TextContent, TextDecoration, TextRun } from "@web2ai/schema";
import { parseColor } from "./css/color.ts";
import { parseLength, parseNumber, round, splitTopLevel, stripQuotes } from "./css/values.ts";
import type { CaptureEnv, DomElementLike, StyleLike } from "./dom.ts";
import { childNodesOf, isElement, isText } from "./dom.ts";

/** `line-height: normal` has no computed pixel value we can read. */
const NORMAL_LINE_HEIGHT_FACTOR = 1.2;

const WEIGHT_KEYWORDS: Readonly<Record<string, number>> = {
  normal: 400,
  bold: 700,
  lighter: 300,
  bolder: 700,
};

export function parseFontWeight(value: string): number {
  const keyword = WEIGHT_KEYWORDS[value.trim().toLowerCase()];
  if (keyword !== undefined) return keyword;
  const numeric = parseNumber(value);
  if (numeric === null) return 400;
  return Math.min(1000, Math.max(1, Math.round(numeric)));
}

export function parseFontStyle(value: string): FontRef["style"] {
  const normalised = value.trim().toLowerCase();
  if (normalised.startsWith("italic")) return "italic";
  if (normalised.startsWith("oblique")) return "oblique";
  return "normal";
}

/** First family of the stack, unquoted — the one the browser most likely used. */
export function primaryFamily(fontFamily: string): string {
  const first = splitTopLevel(fontFamily, ",")[0] ?? "";
  return stripQuotes(first);
}

export function readFont(style: StyleLike, webFontFamilies: ReadonlySet<string>): FontRef {
  const stack = style.getPropertyValue("font-family");
  const family = primaryFamily(stack);
  return {
    family,
    weight: parseFontWeight(style.getPropertyValue("font-weight")),
    style: parseFontStyle(style.getPropertyValue("font-style")),
    isWebFont: webFontFamilies.has(family.toLowerCase()),
    stack,
  };
}

export function parseTextAlign(value: string): TextAlign {
  const normalised = value.trim().toLowerCase();
  switch (normalised) {
    case "left":
    case "right":
    case "center":
    case "justify":
    case "start":
    case "end":
      return normalised;
    case "-webkit-center":
      return "center";
    case "-webkit-left":
      return "left";
    case "-webkit-right":
      return "right";
    default:
      return "start";
  }
}

function parseDecoration(value: string): TextDecoration | undefined {
  const normalised = value.toLowerCase();
  if (normalised.includes("underline")) return "underline";
  if (normalised.includes("line-through")) return "line-through";
  if (normalised.includes("overline")) return "overline";
  return undefined;
}

export function resolveLineHeight(value: string, fontSize: number): number {
  const normalised = value.trim().toLowerCase();
  if (normalised === "normal" || normalised === "") {
    return round(fontSize * NORMAL_LINE_HEIGHT_FACTOR);
  }
  const length = parseLength(normalised);
  if (length !== null) return round(length);
  // A unitless number is a multiplier of the font size.
  const factor = parseNumber(normalised);
  return factor === null ? round(fontSize * NORMAL_LINE_HEIGHT_FACTOR) : round(factor * fontSize);
}

export function resolveLetterSpacing(value: string): number {
  const normalised = value.trim().toLowerCase();
  if (normalised === "normal" || normalised === "") return 0;
  return round(parseLength(normalised) ?? 0);
}

/** True when `white-space` collapses runs of whitespace. */
function collapsesWhitespace(whiteSpace: string): boolean {
  const normalised = whiteSpace.trim().toLowerCase();
  return normalised !== "pre" && normalised !== "pre-wrap" && normalised !== "break-spaces";
}

function applyTextTransform(text: string, transform: string): string {
  switch (transform.trim().toLowerCase()) {
    case "uppercase":
      return text.toUpperCase();
    case "lowercase":
      return text.toLowerCase();
    case "capitalize":
      return text.replace(/(^|\s)(\p{L})/gu, (_match, prefix: string, letter: string) => {
        return prefix + letter.toUpperCase();
      });
    default:
      return text;
  }
}

/**
 * Builds a run for a pseudo-element's `content` string.
 *
 * Unlike element text, the edge whitespace is *kept*: `content: "— "` renders
 * an em dash and a space in front of the element's own text, and trimming that
 * space would run the two together.
 *
 * Returns null when the content contributes no visible characters.
 */
export function pseudoRun(style: StyleLike, rawContent: string, env: CaptureEnv): TextRun | null {
  const collapse = collapsesWhitespace(style.getPropertyValue("white-space"));
  const chars = collapse ? rawContent.replace(/\s+/g, " ") : rawContent;
  if (chars.trim().length === 0) return null;
  return buildRun(style, applyTextTransform(chars, style.getPropertyValue("text-transform")), env);
}

function buildRun(style: StyleLike, chars: string, env: CaptureEnv): TextRun {
  const fontSize = parseLength(style.getPropertyValue("font-size")) ?? 16;
  const color = parseColor(style.getPropertyValue("color")) ?? { r: 0, g: 0, b: 0, a: 1 };
  const decoration = parseDecoration(style.getPropertyValue("text-decoration-line"));

  const run: TextRun = {
    chars,
    font: readFont(style, env.webFontFamilies),
    size: round(fontSize),
    color,
    lineHeight: resolveLineHeight(style.getPropertyValue("line-height"), fontSize),
    letterSpacing: resolveLetterSpacing(style.getPropertyValue("letter-spacing")),
    align: parseTextAlign(style.getPropertyValue("text-align")),
  };
  return decoration === undefined ? run : { ...run, decoration };
}

export interface TextExtraction {
  text: TextContent;
  reasons: string[];
}

/**
 * Extracts text runs from an element, or returns null when the element is not
 * a text container.
 *
 * The base rule is the one from the spec sketch: an element whose children are
 * *only* text nodes becomes a `text` node. That rule alone gives up on the
 * extremely common `<p>some <strong>bold</strong> text</p>`, so one level of
 * inline children that themselves contain only text is also accepted and
 * contributes its own run. Anything deeper is refused, and the element is
 * walked as a box instead — no silent flattening.
 */
export function extractText(
  element: DomElementLike,
  style: StyleLike,
  env: CaptureEnv,
  rect: { h: number },
): TextExtraction | null {
  const children = childNodesOf(element);
  if (children.length === 0) return null;

  const whiteSpace = style.getPropertyValue("white-space");
  const collapse = collapsesWhitespace(whiteSpace);
  const transform = style.getPropertyValue("text-transform");
  const reasons: string[] = [];

  interface Piece {
    style: StyleLike;
    text: string;
  }
  const pieces: Piece[] = [];

  for (const child of children) {
    if (isText(child)) {
      pieces.push({ style, text: child.data });
      continue;
    }
    if (!isElement(child)) return null;

    const childStyle = env.getComputedStyle(child);
    const display = childStyle.getPropertyValue("display").trim().toLowerCase();
    if (!display.startsWith("inline")) return null;

    const grandChildren = childNodesOf(child);
    if (grandChildren.length === 0) continue;
    if (!grandChildren.every(isText)) return null;

    const childText = grandChildren.map((node) => (isText(node) ? node.data : "")).join("");
    pieces.push({ style: childStyle, text: childText });
  }

  if (pieces.length === 0) return null;

  // Collapse whitespace across the whole element, not per piece, so that
  // `<span>a </span><span> b</span>` yields one space and not two.
  let normalised = pieces.map((piece) => ({
    style: piece.style,
    text: collapse ? piece.text.replace(/\s+/g, " ") : piece.text,
  }));

  if (collapse) {
    const first = normalised[0];
    if (first !== undefined) first.text = first.text.replace(/^ /, "");
    const last = normalised[normalised.length - 1];
    if (last !== undefined) last.text = last.text.replace(/ $/, "");
  }

  normalised = normalised.filter((piece) => piece.text.length > 0);
  if (normalised.length === 0) return null;
  if (normalised.every((piece) => piece.text.trim().length === 0)) return null;

  const runs = normalised.map((piece) =>
    buildRun(piece.style, applyTextTransform(piece.text, transform), env),
  );

  if (runs.length > 1) reasons.push("text-multiple-runs");
  if (!collapse) reasons.push("text-preformatted-whitespace-preserved");

  const maxLineHeight = runs.reduce((max, run) => Math.max(max, run.lineHeight), 0);
  const hasHardBreak = runs.some((run) => run.chars.includes("\n"));
  const isSingleLine = !hasHardBreak && maxLineHeight > 0 && rect.h <= maxLineHeight * 1.5;

  return { text: { runs, isSingleLine }, reasons };
}
