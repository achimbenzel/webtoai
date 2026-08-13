import { defaultCaptureOptions, validateScene } from "@web2ai/schema";
import type { CaptureOptions, SceneNode } from "@web2ai/schema";
import { describe, expect, it } from "vitest";
import { dropPrunedNodes, walk } from "../src/lib/walker.ts";
import { createFakeEnv, type FakeEnvOptions, type FakeSpec } from "./fake-dom.ts";

function capture(
  spec: FakeSpec,
  overrides: Partial<CaptureOptions> = {},
  envOptions: FakeEnvOptions = {},
) {
  const options: CaptureOptions = { ...defaultCaptureOptions(), ...overrides };
  const env = createFakeEnv(spec, envOptions);
  const result = walk(env, options);
  result.scene.root = dropPrunedNodes(result.scene.root);
  return result;
}

/** Depth-first list of names, useful for asserting structure compactly. */
function names(node: SceneNode): string[] {
  return [node.name, ...node.children.flatMap(names)];
}

function findByName(node: SceneNode, name: string): SceneNode | undefined {
  if (node.name === name) return node;
  for (const child of node.children) {
    const found = findByName(child, name);
    if (found !== undefined) return found;
  }
  return undefined;
}

const filled = { "background-color": "rgb(200, 200, 200)" };

describe("walker — output contract", () => {
  it("produces a schema-valid scene", () => {
    const { scene } = capture({
      tag: "body",
      style: filled,
      rect: { width: 1280, height: 600 },
      children: [
        { tag: "header", id: "top", style: filled, rect: { width: 1280, height: 80 } },
        { tag: "p", text: "Hello world", rect: { y: 80, width: 400, height: 24 } },
      ],
    });

    const result = validateScene(scene);
    expect(result.ok, result.ok ? "" : result.message).toBe(true);
    expect(scene.version).toBe(1);
    expect(scene.source.url).toBe("https://example.test/");
  });

  it("names nodes tag#id.class for the layer palette", () => {
    const { scene } = capture({
      tag: "div",
      style: filled,
      children: [
        { tag: "nav", id: "main", className: "bar sticky extra", style: filled },
        { tag: "span", style: filled },
      ],
    });
    expect(names(scene.root)).toEqual(["div", "nav#main.bar.sticky", "span"]);
  });

  it("deduplicates sibling names so the palette stays readable", () => {
    const { scene } = capture({
      tag: "ul",
      style: filled,
      children: [
        { tag: "li", className: "item", style: filled },
        { tag: "li", className: "item", style: filled },
        { tag: "li", className: "item", style: filled },
      ],
    });
    expect(names(scene.root)).toEqual(["ul", "li.item", "li.item (2)", "li.item (3)"]);
  });

  it("gives every node a stable, deterministic id across captures", () => {
    const spec: FakeSpec = {
      tag: "div",
      style: filled,
      children: [{ tag: "span", style: filled }],
    };
    expect(capture(spec).scene.root.id).toBe(capture(spec).scene.root.id);
    expect(capture(spec).scene.root.children[0]?.id).toBe(capture(spec).scene.root.children[0]?.id);
  });
});

describe("walker — geometry", () => {
  it("converts viewport rects to absolute document coordinates", () => {
    const { scene } = capture(
      { tag: "div", style: filled, rect: { x: 10, y: 20, width: 100, height: 50 } },
      {},
      { scroll: { x: 5, y: 200 } },
    );
    expect(scene.root.frame).toEqual({ x: 15, y: 220, w: 100, h: 50 });
  });

  it("takes the artboard size from the full document, not the viewport", () => {
    const { scene } = capture(
      { tag: "div", style: filled },
      { fullPage: true },
      { viewport: { w: 1280, h: 800, dpr: 2 }, documentSize: { w: 1280, h: 4200 } },
    );
    expect(scene.source.document).toEqual({ w: 1280, h: 4200 });
    expect(scene.source.viewport).toEqual({ w: 1280, h: 800, dpr: 2 });
  });

  it("drops off-screen nodes in viewport mode but keeps them in full-page mode", () => {
    const spec: FakeSpec = {
      tag: "body",
      style: filled,
      rect: { width: 1280, height: 3000 },
      children: [
        { tag: "section", className: "above", style: filled, rect: { y: 100, height: 200 } },
        { tag: "section", className: "below", style: filled, rect: { y: 2000, height: 200 } },
      ],
    };
    expect(names(capture(spec, { fullPage: true }).scene.root)).toContain("section.below");
    expect(names(capture(spec, { fullPage: false }).scene.root)).not.toContain("section.below");
  });
});

describe("walker — skip rules", () => {
  it("skips display:none, visibility:hidden and opacity:0 subtrees", () => {
    const { scene } = capture({
      tag: "div",
      style: filled,
      children: [
        { tag: "p", className: "gone", style: { display: "none" }, children: [{ tag: "b" }] },
        { tag: "p", className: "invisible", style: { visibility: "hidden", ...filled } },
        { tag: "p", className: "clear", style: { opacity: "0", ...filled } },
        { tag: "p", className: "kept", style: filled },
      ],
    });
    expect(names(scene.root)).toEqual(["div", "p.kept"]);
  });

  it("never walks script/style/head elements", () => {
    const { scene } = capture({
      tag: "body",
      style: filled,
      children: [
        { tag: "script", style: filled },
        { tag: "style", style: filled },
        { tag: "noscript", style: filled },
        { tag: "div", style: filled },
      ],
    });
    expect(names(scene.root)).toEqual(["body", "div"]);
  });

  it("honours configured skip selectors", () => {
    const { scene, log } = capture(
      {
        tag: "div",
        style: filled,
        children: [
          { tag: "aside", className: "ads", style: filled },
          { tag: "section", style: filled },
        ],
      },
      { skipSelectors: [".ads"] },
    );
    expect(names(scene.root)).toEqual(["div", "section"]);
    expect(log.summary().map((row) => row.code)).toContain("skipped-by-selector");
  });

  it("prunes leaves that paint nothing, and reports how many", () => {
    const { scene, log } = capture({
      tag: "div",
      style: filled,
      children: [
        { tag: "div", className: "spacer" },
        { tag: "div", className: "spacer" },
        { tag: "div", className: "visible", style: filled },
      ],
    });
    expect(names(scene.root)).toEqual(["div", "div.visible"]);
    const pruned = log.summary().find((row) => row.code === "pruned-empty-leaf");
    expect(pruned?.count).toBe(2);
  });

  it("keeps an unpainted element that has painted children", () => {
    const { scene } = capture({
      tag: "div",
      style: filled,
      children: [{ tag: "div", className: "wrapper", children: [{ tag: "b", style: filled }] }],
    });
    expect(names(scene.root)).toEqual(["div", "div.wrapper", "b"]);
  });

  it("stops at max depth and says so instead of truncating silently", () => {
    const { scene } = capture(
      {
        tag: "div",
        style: filled,
        children: [
          {
            tag: "div",
            className: "l2",
            style: filled,
            children: [{ tag: "div", className: "l3", style: filled }],
          },
        ],
      },
      { maxDepth: 2 },
    );
    expect(names(scene.root)).toEqual(["div", "div.l2"]);
    expect(findByName(scene.root, "div.l2")?.unsupportedReasons).toContain("max-depth-reached");
  });
});

describe("walker — paint", () => {
  it("reads a solid background colour", () => {
    const { scene } = capture({ tag: "div", style: { "background-color": "rgb(255, 0, 0)" } });
    expect(scene.root.paint.fill).toEqual({ kind: "solid", color: { r: 255, g: 0, b: 0, a: 1 } });
  });

  it("prefers a gradient over the colour underneath it, and reports the loss", () => {
    const { scene } = capture({
      tag: "div",
      rect: { width: 100, height: 100 },
      style: {
        "background-color": "rgb(255, 0, 0)",
        "background-image": "linear-gradient(rgb(0, 0, 0), rgb(255, 255, 255))",
      },
    });
    expect(scene.root.paint.fill).toMatchObject({ kind: "linear-gradient", angle: 180 });
    expect(scene.root.unsupportedReasons).toContain("background-color-behind-gradient");
  });

  it("reads borders and flags unequal widths for the four-path renderer", () => {
    const { scene } = capture({
      tag: "div",
      style: {
        ...filled,
        "border-top-width": "2px",
        "border-bottom-width": "4px",
        "border-top-style": "solid",
        "border-bottom-style": "solid",
        "border-top-color": "rgb(255, 0, 0)",
        "border-bottom-color": "rgb(0, 0, 255)",
      },
    });
    expect(scene.root.paint.stroke).toMatchObject({
      widths: [2, 0, 4, 0],
      color: { r: 0, g: 0, b: 255, a: 1 },
    });
    expect(scene.root.paint.stroke?.colors).toHaveLength(4);
    expect(scene.root.unsupportedReasons).toContain("border-widths-differ");
  });

  it("ignores a declared width when the border style is none", () => {
    const { scene } = capture({
      tag: "div",
      style: { ...filled, "border-top-width": "5px", "border-top-style": "none" },
    });
    expect(scene.root.paint.stroke).toBeUndefined();
  });

  it("records overflow as a clip request", () => {
    const { scene } = capture({ tag: "div", style: { ...filled, "overflow-x": "hidden" } });
    expect(scene.root.clip).toBe(true);
  });

  it("carries the transform as metadata and flags the baked-in bounds", () => {
    const { scene } = capture({
      tag: "div",
      style: { ...filled, transform: "matrix(0, 1, -1, 0, 0, 0)" },
    });
    expect(scene.root.transform).toEqual([0, 1, -1, 0, 0, 0]);
    expect(scene.root.unsupportedReasons).toContain("transform-baked-into-bounds");
  });
});

describe("walker — text", () => {
  it("turns an element with only text children into a text node", () => {
    const { scene } = capture({
      tag: "p",
      text: "Hello",
      rect: { width: 200, height: 20 },
      style: { "font-size": "16px", "line-height": "20px", color: "rgb(17, 17, 17)" },
    });
    expect(scene.root.role).toBe("text");
    expect(scene.root.text?.runs).toEqual([
      {
        chars: "Hello",
        font: { family: "Arial", weight: 400, style: "normal", isWebFont: false, stack: "Arial" },
        size: 16,
        color: { r: 17, g: 17, b: 17, a: 1 },
        lineHeight: 20,
        letterSpacing: 0,
        align: "start",
      },
    ]);
    expect(scene.root.text?.isSingleLine).toBe(true);
  });

  it("splits inline children into separate runs", () => {
    const { scene } = capture({
      tag: "p",
      text: "plain ",
      rect: { width: 300, height: 20 },
      style: { "line-height": "20px" },
      children: [
        { tag: "strong", text: "bold", style: { display: "inline", "font-weight": "700" } },
      ],
    });
    expect(scene.root.role).toBe("text");
    expect(scene.root.text?.runs.map((run) => [run.chars, run.font.weight])).toEqual([
      ["plain ", 400],
      ["bold", 700],
    ]);
  });

  it("keeps the spaces between interleaved text and inline elements", () => {
    // The paragraph shape that is everywhere, with the spaces living in the
    // text nodes *between* the elements. Lose them and every word in the
    // paragraph runs into the next.
    const { scene } = capture({
      tag: "p",
      rect: { width: 600, height: 20 },
      style: { "line-height": "20px" },
      content: [
        "Als ",
        { tag: "strong", text: "freiberuflicher Designer", style: { display: "inline" } },
        " entwickle ",
        { tag: "em", text: "ich", style: { display: "inline" } },
        " Websites.",
      ],
    });
    expect(scene.root.text?.runs.map((run) => run.chars).join("")).toBe(
      "Als freiberuflicher Designer entwickle ich Websites.",
    );
  });

  it("keeps one space where markup put a newline on both sides of a tag", () => {
    // Pretty-printed HTML puts a newline before and after the inline element;
    // the browser renders exactly one space, not two.
    const { scene } = capture({
      tag: "p",
      rect: { width: 600, height: 20 },
      style: { "line-height": "20px" },
      content: [
        "\n      Als\n      ",
        { tag: "span", text: "freiberuflicher", style: { display: "inline" } },
        "\n      Designer\n    ",
      ],
    });
    expect(scene.root.text?.runs.map((run) => run.chars).join("")).toBe(
      "Als freiberuflicher Designer",
    );
  });

  it("flattens a whole inline subtree, keeping the text between the tags", () => {
    // One level of nesting used to be the limit: anything deeper was walked as
    // a box, and the bare text nodes then had nowhere to go and were dropped
    // without a word. This paragraph came out as the four words in the <em>.
    const { scene } = capture({
      tag: "p",
      rect: { width: 600, height: 20 },
      style: { "line-height": "20px" },
      content: [
        "Als ",
        {
          tag: "span",
          style: { display: "inline" },
          children: [
            {
              tag: "em",
              text: "freiberuflicher Designer",
              style: { display: "inline", "font-style": "italic" },
            },
          ],
        },
        " entwickle ich Websites.",
      ],
    });
    expect(scene.root.role).toBe("text");
    expect(scene.root.text?.runs.map((run) => run.chars).join("")).toBe(
      "Als freiberuflicher Designer entwickle ich Websites.",
    );
    expect(scene.root.text?.runs.map((run) => run.font.style)).toEqual([
      "normal",
      "italic",
      "normal",
    ]);
  });

  it("descends through display: contents, which has no box at all", () => {
    const { scene } = capture({
      tag: "p",
      rect: { width: 600, height: 20 },
      style: { "line-height": "20px" },
      content: [
        "before ",
        { tag: "div", text: "inside", style: { display: "contents" } },
        " after",
      ],
    });
    expect(scene.root.text?.runs.map((run) => run.chars).join("")).toBe("before inside after");
  });

  it("merges neighbouring runs that a wrapper element did not actually restyle", () => {
    // Animation hooks and link wrappers produce a piece per element even when
    // nothing changes; each one costs the renderer a per-character pass. The
    // styles are spelled out on every element because the fake DOM has no
    // inheritance — in a browser these three would compute the same anyway.
    const inline = { display: "inline", "line-height": "20px" };
    const { scene } = capture({
      tag: "p",
      rect: { width: 600, height: 20 },
      style: { "line-height": "20px" },
      content: [
        "one ",
        { tag: "span", text: "two ", style: inline },
        { tag: "span", text: "three", style: inline },
      ],
    });
    expect(scene.root.text?.runs).toHaveLength(1);
    expect(scene.root.text?.runs[0]?.chars).toBe("one two three");
  });

  it("collapses whitespace across tag boundaries, not once per piece", () => {
    // Pretty-printed markup puts a newline on both sides of the tag. Collapsing
    // per piece leaves two spaces; the browser renders one.
    const { scene } = capture({
      tag: "p",
      rect: { width: 600, height: 20 },
      style: { "line-height": "20px" },
      content: [
        "Als\n  ",
        { tag: "span", text: "\n  freiberuflicher\n  ", style: { display: "inline" } },
        "\n  Designer",
      ],
    });
    expect(scene.root.text?.runs.map((run) => run.chars).join("")).toBe(
      "Als freiberuflicher Designer",
    );
  });

  it("reports the paint an inline element loses when it is folded into a run", () => {
    const { scene } = capture({
      tag: "p",
      rect: { width: 600, height: 20 },
      style: { "line-height": "20px" },
      content: [
        "a ",
        {
          tag: "mark",
          text: "highlighted",
          style: { display: "inline", "background-color": "rgb(255, 240, 0)" },
        },
      ],
    });
    expect(scene.root.role).toBe("text");
    expect(scene.root.unsupportedReasons).toContain("inline-paint-dropped");
  });

  it("keeps the text around an inline image, which cannot be folded into a run", () => {
    // A replaced element has its own size and paint, so the paragraph has to
    // be a box. The text either side then has no element node to live in — it
    // is laid out in an anonymous block box, and that is what it becomes.
    const { scene } = capture({
      tag: "p",
      style: filled,
      rect: { width: 600, height: 20 },
      content: [
        { data: "Read the ", rect: { x: 0, y: 0, width: 60, height: 20 } },
        { tag: "img", image: { src: "/icon.png", width: 16, height: 16 } },
        { data: " docs.", rect: { x: 76, y: 0, width: 40, height: 20 } },
      ],
    });
    expect(scene.root.role).toBe("box");
    const text = scene.root.children.filter((child) => child.role === "text");
    expect(text.map((child) => child.text?.runs[0]?.chars)).toEqual(["Read the", "docs."]);
    // Real geometry, from a Range over the text node — not the parent's box.
    expect(text[0]?.frame).toEqual({ x: 0, y: 0, w: 60, h: 20 });
    expect(text[1]?.frame).toEqual({ x: 76, y: 0, w: 40, h: 20 });
  });

  it("keeps bare text sitting next to a block child", () => {
    // `<div>label<div>…</div></div>` — the shape that made a whole paragraph
    // disappear, because the walker only ever descended into element children.
    const { scene } = capture({
      tag: "div",
      style: filled,
      rect: { width: 400, height: 200 },
      content: [
        { data: "opacity: 0.99 wrapper", rect: { x: 8, y: 8, width: 200, height: 20 } },
        { tag: "div", className: "inner", style: filled, rect: { y: 30 } },
      ],
    });
    expect(names(scene.root)).toEqual(["div", "div.inner", "#text"]);
    const text = findByName(scene.root, "#text");
    expect(text?.text?.runs[0]?.chars).toBe("opacity: 0.99 wrapper");
    expect(text?.frame).toEqual({ x: 8, y: 8, w: 200, h: 20 });
  });

  it("reports the loss when the anonymous box cannot be measured", () => {
    const { scene } = capture({
      tag: "div",
      style: filled,
      content: [
        { data: "unmeasurable", rect: null },
        { tag: "div", className: "inner", style: filled },
      ],
    });
    expect(findByName(scene.root, "#text")).toBeUndefined();
    expect(scene.root.unsupportedReasons).toContain("text-outside-inline-context");
  });

  it("refuses to flatten a block child into text", () => {
    const { scene } = capture({
      tag: "div",
      text: "loose text",
      style: filled,
      children: [{ tag: "div", className: "block", style: filled }],
    });
    expect(scene.root.role).toBe("box");
    // The block child forces a box; "loose text" is not folded into it, but it
    // is not dropped either — it becomes the anonymous box CSS laid out for it.
    expect(names(scene.root)).toEqual(["div", "div.block", "#text"]);
    expect(findByName(scene.root, "#text")?.text?.runs[0]?.chars).toBe("loose text");
  });

  it("collapses whitespace unless white-space preserves it", () => {
    const collapsed = capture({
      tag: "p",
      text: "  lots   of\n  space  ",
      rect: { height: 20 },
      style: { "line-height": "20px" },
    });
    expect(collapsed.scene.root.text?.runs[0]?.chars).toBe("lots of space");

    const preserved = capture({
      tag: "pre",
      text: "  keep  me  ",
      rect: { height: 20 },
      style: { "white-space": "pre", "line-height": "20px" },
    });
    expect(preserved.scene.root.text?.runs[0]?.chars).toBe("  keep  me  ");
  });

  it("resolves line-height: normal and letter-spacing: normal", () => {
    const { scene } = capture({
      tag: "p",
      text: "x",
      rect: { height: 20 },
      style: { "font-size": "20px" },
    });
    expect(scene.root.text?.runs[0]?.lineHeight).toBe(24);
    expect(scene.root.text?.runs[0]?.letterSpacing).toBe(0);
  });

  it("applies text-transform, because Illustrator receives characters not CSS", () => {
    const { scene } = capture({
      tag: "p",
      text: "shout",
      rect: { height: 20 },
      style: { "text-transform": "uppercase", "line-height": "20px" },
    });
    expect(scene.root.text?.runs[0]?.chars).toBe("SHOUT");
  });

  it("detects multi-line text", () => {
    const { scene } = capture({
      tag: "p",
      text: "a long paragraph",
      rect: { width: 200, height: 80 },
      style: { "line-height": "20px" },
    });
    expect(scene.root.text?.isSingleLine).toBe(false);
  });

  it("collects every distinct font into scene.fonts", () => {
    const { scene } = capture(
      {
        tag: "div",
        style: filled,
        children: [
          { tag: "p", text: "a", rect: { height: 20 }, style: { "font-family": "Inter" } },
          { tag: "p", text: "b", rect: { height: 20 }, style: { "font-family": "Inter" } },
          {
            tag: "p",
            text: "c",
            rect: { height: 20 },
            style: { "font-family": "Inter", "font-weight": "700" },
          },
        ],
      },
      {},
      { webFontFamilies: ["inter"] },
    );
    expect(scene.fonts).toEqual([
      { family: "Inter", weight: 400, style: "normal", isWebFont: true, stack: "Inter" },
      { family: "Inter", weight: 700, style: "normal", isWebFont: true, stack: "Inter" },
    ]);
  });
});

describe("walker — assets", () => {
  it("records an <img> as an asset request with its intrinsic size", () => {
    const { scene, assetRequests } = capture({
      tag: "div",
      style: filled,
      children: [
        {
          tag: "img",
          rect: { width: 200, height: 100 },
          image: { src: "/logo.png", width: 400, height: 200 },
        },
      ],
    });
    const img = findByName(scene.root, "img");
    expect(img?.role).toBe("image");
    expect(assetRequests).toEqual([
      {
        id: img?.assetId,
        kind: "raster",
        url: "https://example.test/logo.png",
        width: 400,
        height: 200,
      },
    ]);
  });

  it("records object-fit, without which every cropped image is stretched", () => {
    const { scene } = capture({
      tag: "div",
      style: filled,
      children: [
        {
          tag: "img",
          rect: { width: 200, height: 100 },
          style: { "object-fit": "cover", "object-position": "50% 0%" },
          image: { src: "/photo.jpg", width: 400, height: 400 },
        },
      ],
    });
    const img = findByName(scene.root, "img");
    expect(img?.objectFit).toBe("cover");
    expect(img?.objectPosition).toEqual({ x: 0.5, y: 0 });
  });

  it("omits object-fit when it is the default, since fill is what a box does", () => {
    const { scene } = capture({
      tag: "div",
      style: filled,
      children: [
        {
          tag: "img",
          style: { "object-fit": "fill", "object-position": "50% 50%" },
          image: { src: "/photo.jpg", width: 400, height: 400 },
        },
      ],
    });
    const img = findByName(scene.root, "img");
    expect(img?.objectFit).toBeUndefined();
    expect(img?.objectPosition).toBeUndefined();
  });

  it("omits a centred object-position, which is the default once fit is set", () => {
    const { scene } = capture({
      tag: "div",
      style: filled,
      children: [
        {
          tag: "img",
          style: { "object-fit": "contain", "object-position": "50% 50%" },
          image: { src: "/photo.jpg", width: 400, height: 400 },
        },
      ],
    });
    const img = findByName(scene.root, "img");
    expect(img?.objectFit).toBe("contain");
    expect(img?.objectPosition).toBeUndefined();
  });

  it("deduplicates the same image used twice", () => {
    const { assetRequests } = capture({
      tag: "div",
      style: filled,
      children: [
        { tag: "img", image: { src: "/a.png", width: 10, height: 10 } },
        { tag: "img", image: { src: "/a.png", width: 10, height: 10 } },
      ],
    });
    expect(assetRequests).toHaveLength(1);
  });

  it("keeps inline SVG source rather than rasterising it", () => {
    const { scene, assetRequests } = capture({
      tag: "div",
      style: filled,
      children: [
        { tag: "svg", svg: "<svg><circle r='5'/></svg>", rect: { width: 24, height: 24 } },
      ],
    });
    expect(findByName(scene.root, "svg")?.role).toBe("svg");
    expect(assetRequests[0]).toMatchObject({
      kind: "svg",
      inline: { mime: "image/svg+xml", data: "<svg><circle r='5'/></svg>" },
    });
  });

  it("reports a tainted canvas instead of emitting a broken image", () => {
    const { scene } = capture({
      tag: "div",
      style: filled,
      children: [
        { tag: "canvas", canvas: { error: "canvas-tainted" }, rect: { width: 50, height: 50 } },
      ],
    });
    const canvas = findByName(scene.root, "canvas");
    expect(canvas?.role).toBe("unsupported");
    expect(canvas?.unsupportedReasons).toContain("canvas-tainted");
  });

  it("attaches a background-image to a container without changing its role", () => {
    const { scene } = capture({
      tag: "div",
      style: { ...filled, "background-image": 'url("/bg.jpg")' },
      children: [{ tag: "span", style: filled }],
    });
    expect(scene.root.role).toBe("box");
    expect(scene.root.assetId).toBeDefined();
    expect(scene.root.unsupportedReasons).toContain("background-positioning-ignored");
  });

  it("marks an iframe unsupported and does not descend", () => {
    const { scene } = capture({
      tag: "div",
      style: filled,
      children: [{ tag: "iframe", style: filled, children: [{ tag: "div", style: filled }] }],
    });
    const iframe = findByName(scene.root, "iframe");
    expect(iframe?.role).toBe("unsupported");
    expect(iframe?.unsupportedReasons).toContain("iframe-content");
    expect(iframe?.children).toEqual([]);
  });
});

describe("walker — paint order", () => {
  it("orders children back-to-front, not in DOM order", () => {
    const { scene } = capture({
      tag: "div",
      style: filled,
      rect: { width: 400, height: 400 },
      children: [
        {
          tag: "div",
          className: "overlay",
          style: { ...filled, position: "absolute", "z-index": "5" },
        },
        { tag: "div", className: "content", style: filled },
      ],
    });
    // DOM order puts the overlay first; paint order puts it last.
    expect(scene.root.children.map((child) => child.name)).toEqual(["div.content", "div.overlay"]);
    expect(scene.root.children[0]?.stackingOrder).toBeLessThan(
      scene.root.children[1]?.stackingOrder ?? -1,
    );
  });

  it("puts a negative z-index child behind its siblings", () => {
    const { scene } = capture({
      tag: "div",
      style: filled,
      children: [
        { tag: "div", className: "normal", style: filled },
        {
          tag: "div",
          className: "behind",
          style: { ...filled, position: "absolute", "z-index": "-1" },
        },
      ],
    });
    expect(scene.root.children.map((child) => child.name)).toEqual(["div.behind", "div.normal"]);
  });

  it("assigns the root the lowest stacking order", () => {
    const { scene } = capture({
      tag: "div",
      style: filled,
      children: [{ tag: "span", style: filled }],
    });
    expect(scene.root.stackingOrder).toBe(0);
    expect(scene.root.children[0]?.stackingOrder).toBe(1);
  });
});

describe("walker — pseudo-elements", () => {
  it("emits a painting ::before with the parent's frame and says the geometry is approximate", () => {
    const { scene } = capture({
      tag: "div",
      className: "badge",
      style: filled,
      rect: { width: 40, height: 20 },
      before: { content: '"NEW"', color: "rgb(255, 255, 255)", "line-height": "20px" },
    });
    const pseudo = scene.root.children[0];
    expect(pseudo?.name).toBe("div.badge::before");
    expect(pseudo?.role).toBe("text");
    expect(pseudo?.text?.runs[0]?.chars).toBe("NEW");
    expect(pseudo?.frame).toEqual(scene.root.frame);
    expect(pseudo?.unsupportedReasons).toContain("pseudo-element-geometry-approximated");
  });

  it("drops the ubiquitous empty clearfix ::after", () => {
    const { scene } = capture({
      tag: "div",
      style: filled,
      after: { content: '""', display: "table" },
    });
    expect(scene.root.children).toEqual([]);
  });

  it("can be switched off entirely", () => {
    const { scene } = capture(
      { tag: "div", style: filled, before: { content: '"x"', ...filled } },
      { capturePseudoElements: false },
    );
    expect(scene.root.children).toEqual([]);
  });
});

describe("walker — resilience", () => {
  it("keeps going when one element throws", () => {
    const spec: FakeSpec = {
      tag: "div",
      style: filled,
      children: [
        { tag: "section", className: "bad", style: filled },
        { tag: "section", className: "good", style: filled },
      ],
    };
    const env = createFakeEnv(spec);
    const original = env.getRect.bind(env);
    const failing = {
      ...env,
      getRect(element: Parameters<typeof original>[0]) {
        if (element.getAttribute("class") === "bad") throw new Error("layout exploded");
        return original(element);
      },
    };

    const result = walk(failing, defaultCaptureOptions());
    expect(names(result.scene.root)).toEqual(["div", "section.good"]);
    expect(result.log.summary().map((row) => row.code)).toContain("node-capture-failed");
  });
});
