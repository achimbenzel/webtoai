import type { FontRef, TextAlign, TextContent, TextDecoration, TextRun } from "@web2ai/schema";
import { parseColor } from "./css/color.ts";
import { parseLength, parseNumber, round, splitTopLevel, stripQuotes } from "./css/values.ts";
import type { CaptureEnv, DomElementLike, DomTextLike, StyleLike } from "./dom.ts";
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
 * Inline-level elements that are *atomic*: they have their own intrinsic size
 * and paint, so folding one into a text run would lose it. An element
 * containing one is not a text node.
 */
const REPLACED_ELEMENTS = new Set([
  "img",
  "svg",
  "canvas",
  "video",
  "audio",
  "iframe",
  "object",
  "embed",
  "input",
  "select",
  "textarea",
]);

/** Guards against a pathologically deep inline tree; far beyond real markup. */
const MAX_INLINE_DEPTH = 12;

interface Piece {
  style: StyleLike;
  text: string;
}

/** True when `display` puts the element in its parent's inline formatting context. */
function isInlineLevel(display: string): boolean {
  const normalised = display.trim().toLowerCase();
  // `contents` has no box at all: its children are laid out as if they were
  // the parent's own, which is exactly what folding does.
  return normalised.startsWith("inline") || normalised === "contents" || normalised === "ruby";
}

/** True when an inline element paints something a text run cannot carry. */
function paintsSomething(style: StyleLike): boolean {
  const background = style.getPropertyValue("background-color").trim().toLowerCase();
  const opaqueBackground =
    background !== "" &&
    background !== "transparent" &&
    background !== "rgba(0, 0, 0, 0)" &&
    background !== "rgba(0,0,0,0)";
  if (opaqueBackground) return true;

  const image = style.getPropertyValue("background-image").trim().toLowerCase();
  if (image !== "" && image !== "none") return true;

  for (const side of ["top", "right", "bottom", "left"]) {
    const width = parseLength(style.getPropertyValue(`border-${side}-width`)) ?? 0;
    const borderStyle = style.getPropertyValue(`border-${side}-style`).trim().toLowerCase();
    if (width > 0 && borderStyle !== "none" && borderStyle !== "hidden") return true;
  }
  return false;
}

/**
 * Flattens an inline subtree into styled pieces, in document order.
 *
 * Returns null as soon as it meets something that is not inline-level content,
 * which makes the caller walk the element as a box instead.
 */
function collectPieces(
  element: DomElementLike,
  style: StyleLike,
  env: CaptureEnv,
  depth: number,
  reasons: string[],
): Piece[] | null {
  if (depth > MAX_INLINE_DEPTH) return null;

  const pieces: Piece[] = [];
  for (const child of childNodesOf(element)) {
    if (isText(child)) {
      pieces.push({ style, text: child.data });
      continue;
    }
    if (!isElement(child)) return null;

    const tag = child.tagName.toLowerCase();
    if (REPLACED_ELEMENTS.has(tag)) return null;

    const childStyle = env.getComputedStyle(child);
    if (!isInlineLevel(childStyle.getPropertyValue("display"))) return null;

    const nested = collectPieces(child, childStyle, env, depth + 1, reasons);
    if (nested === null) return null;
    // An inline element with a background or a border of its own -- a
    // highlight, a pill, an underline drawn as a border -- keeps its
    // characters but loses that paint. Say so rather than lose it quietly.
    if (nested.length > 0 && paintsSomething(childStyle)) reasons.push("inline-paint-dropped");
    for (const piece of nested) pieces.push(piece);
  }
  return pieces;
}

/**
 * Collapses whitespace across the whole inline formatting context.
 *
 * CSS collapses a run of whitespace to one space *regardless of the tag
 * boundaries it spans*, so pretty-printed markup — a newline before the
 * `<span>` and another after it — renders as a single space, not two. Doing it
 * per piece produces a double space at every tag boundary, which is visible in
 * a text frame and gets worse the more inline elements a paragraph has.
 *
 * Leading and trailing whitespace of the whole context is dropped, as CSS does.
 */
function collapseAcross(pieces: readonly Piece[]): Piece[] {
  const out: Piece[] = [];
  // The context starts as if a space had just been emitted, which is what
  // drops leading whitespace.
  let atSpace = true;

  for (const piece of pieces) {
    let text = "";
    for (const token of piece.text.split(/(\s+)/)) {
      if (token === "") continue;
      if (/^\s+$/.test(token)) {
        if (!atSpace) {
          text += " ";
          atSpace = true;
        }
        continue;
      }
      text += token;
      atSpace = false;
    }
    out.push({ style: piece.style, text });
  }

  for (let index = out.length - 1; index >= 0; index -= 1) {
    const piece = out[index];
    if (piece === undefined || piece.text === "") continue;
    if (piece.text.endsWith(" ")) piece.text = piece.text.slice(0, -1);
    break;
  }
  return out;
}

/**
 * Joins neighbouring runs that are styled identically.
 *
 * Flattening a whole inline subtree produces a piece per element even when the
 * element changes nothing — a `<span>` used only as an animation hook, a
 * `<a>` inheriting its colour. Each extra run costs the renderer a
 * per-character styling pass, and every run past the first is reported as
 * mixed styling that is not really mixed.
 */
function mergeAdjacentRuns(runs: readonly TextRun[]): TextRun[] {
  const merged: TextRun[] = [];
  for (const run of runs) {
    const previous = merged[merged.length - 1];
    if (previous !== undefined && sameStyle(previous, run)) {
      merged[merged.length - 1] = { ...previous, chars: previous.chars + run.chars };
      continue;
    }
    merged.push(run);
  }
  return merged;
}

function sameStyle(a: TextRun, b: TextRun): boolean {
  return (
    a.size === b.size &&
    a.lineHeight === b.lineHeight &&
    a.letterSpacing === b.letterSpacing &&
    a.align === b.align &&
    a.decoration === b.decoration &&
    a.color.r === b.color.r &&
    a.color.g === b.color.g &&
    a.color.b === b.color.b &&
    a.color.a === b.color.a &&
    a.font.family === b.font.family &&
    a.font.weight === b.font.weight &&
    a.font.style === b.font.style
  );
}

/**
 * Text nodes sitting directly inside an element that is being built as a box.
 *
 * When an element's content is not entirely inline — `<div>a label<div>…` —
 * CSS wraps each stretch of bare text in an *anonymous block box*. The walker
 * only descends into element children, so without this that text has no node
 * to go into and disappears. It is extremely common markup.
 */
export function orphanedTextNodes(element: DomElementLike): DomTextLike[] {
  return childNodesOf(element).filter(
    (child): child is DomTextLike => isText(child) && child.data.trim().length > 0,
  );
}

/**
 * Builds the text content of one anonymous block box.
 *
 * Whitespace is collapsed and the edges trimmed: the anonymous box begins and
 * ends at the block sibling that forced it into existence, and CSS drops
 * whitespace at both ends of a line.
 */
export function anonymousText(
  style: StyleLike,
  data: string,
  env: CaptureEnv,
  rect: { h: number },
): TextContent | null {
  const collapse = collapsesWhitespace(style.getPropertyValue("white-space"));
  const raw = collapse ? data.replace(/\s+/g, " ").replace(/^ /, "").replace(/ $/, "") : data;
  if (raw.trim().length === 0) return null;

  const chars = applyTextTransform(raw, style.getPropertyValue("text-transform"));
  const run = buildRun(style, chars, env);
  const isSingleLine =
    !chars.includes("\n") && run.lineHeight > 0 && rect.h <= run.lineHeight * 1.5;
  return { runs: [run], isSingleLine };
}

/**
 * Extracts text runs from an element, or returns null when the element is not
 * a text container.
 *
 * The rule is CSS's own: an element whose content is entirely inline-level
 * establishes an inline formatting context, and that is exactly what a text
 * frame is. So the whole inline subtree is flattened into runs, one per
 * distinct style — `<p>Als <span><em>freiberuflicher Designer</em></span>
 * entwickle ich</p>` is one text frame with three runs.
 *
 * This used to accept only one level of inline nesting and walk anything
 * deeper as a box. The text nodes between the elements then had nowhere to go
 * and were dropped without a word: that paragraph came out as the four words
 * inside the `<em>` and nothing else.
 *
 * Anything that is not inline-level content — a block child, a replaced
 * element — still refuses, and the element is walked as a box.
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

  const pieces = collectPieces(element, style, env, 0, reasons);
  if (pieces === null || pieces.length === 0) return null;

  const normalised = (collapse ? collapseAcross(pieces) : pieces.slice()).filter(
    (piece) => piece.text.length > 0,
  );
  if (normalised.length === 0) return null;
  if (normalised.every((piece) => piece.text.trim().length === 0)) return null;

  const runs = mergeAdjacentRuns(
    normalised.map((piece) =>
      buildRun(piece.style, applyTextTransform(piece.text, transform), env),
    ),
  );

  if (runs.length > 1) reasons.push("text-multiple-runs");
  if (!collapse) reasons.push("text-preformatted-whitespace-preserved");

  const maxLineHeight = runs.reduce((max, run) => Math.max(max, run.lineHeight), 0);
  const hasHardBreak = runs.some((run) => run.chars.includes("\n"));
  const isSingleLine = !hasHardBreak && maxLineHeight > 0 && rect.h <= maxLineHeight * 1.5;

  return { text: { runs, isSingleLine }, reasons };
}
