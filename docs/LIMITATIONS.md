# Limitations

This file is the honest inventory. Everything listed here is either **not
implemented** or **deliberately approximated**. Nothing in web2ai silently
pretends to support something it does not: every item below has a matching
`unsupportedReasons` code that lands in the node, in the import report, and in
the capture log.

Status legend: **unsupported** (skipped, reported) · **approximated**
(rendered, but not faithful, reported) · **planned** (milestone noted).

---

## Capture side (Chrome extension)

### Not representable in a vector document

| Feature                                                         | Status       | Reason code                 | Notes                                                                                                                                               |
| --------------------------------------------------------------- | ------------ | --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| WebGL / `<canvas>` with a 3D context                            | approximated | `canvas-3d-rasterised`      | Captured as a raster snapshot via `toDataURL` when readable. A 3D scene is not vector data; there is nothing better to do.                          |
| `<video>`                                                       | unsupported  | `video-element`             | The current frame is not accessible without playback control. The node degrades to its background box.                                              |
| `backdrop-filter`                                               | unsupported  | `backdrop-filter`           | Depends on what is painted _behind_ the element. Illustrator has no equivalent live effect.                                                         |
| CSS `filter` (`blur`, `saturate`, …)                            | unsupported  | `css-filter`                | Only `opacity` survives. Filters do participate in stacking context detection, so ordering stays correct.                                           |
| CSS `mask` / `clip-path` beyond `overflow`                      | unsupported  | `css-mask`, `css-clip-path` | Rectangular `overflow` clipping _is_ supported.                                                                                                     |
| `mix-blend-mode` other than `normal`                            | approximated | `blend-mode-approximated`   | Carried in `paint.blendMode`; Illustrator's blend modes do not map one-to-one and the renderer falls back to `normal` for anything it cannot match. |
| Animations, transitions, `:hover` / `:focus` / `:active` states | unsupported  | —                           | web2ai captures exactly one frame in the DOM's current state. Nothing is triggered, nothing is waited for.                                          |
| `@media` breakpoints other than the current viewport            | unsupported  | —                           | Capture the page at the width you want. One capture is one breakpoint.                                                                              |

### Document structure

| Feature                                    | Status      | Reason code               | Notes                                                                                                                                                                               |
| ------------------------------------------ | ----------- | ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<iframe>` content                         | unsupported | `iframe-content`          | Cross-origin frames are unreadable by design; same-origin frames are not walked either, because their document has its own coordinate space. The frame is captured as an empty box. |
| Shadow DOM                                 | unsupported | `shadow-root`             | Open shadow roots are not descended into. The host element is captured as a box.                                                                                                    |
| `<object>` / `<embed>` / plugins           | unsupported | `embedded-object`         |                                                                                                                                                                                     |
| Scrolled-away content in scroll containers | unsupported | `overflow-scroll-clipped` | Only what is laid out is captured; a scroll container's off-screen children are captured at their laid-out positions and then clipped, matching what the page renders.              |

### Approximations you should know about

| Feature                                     | Status       | Reason code                            | Notes                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------------------------- | ------------ | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Pseudo-elements (`::before` / `::after`)    | approximated | `pseudo-element-geometry-approximated` | `getComputedStyle(el, "::before")` returns _style_ but no geometry — pseudo-elements have no box in the DOM API. They are emitted with the parent's border-box frame. Only pseudo-elements that actually paint something (text content, background, border) are emitted; empty clearfix `::after` rules are skipped.                                                                                               |
| Multiple `background-image` layers          | approximated | `multiple-backgrounds`                 | Only the first layer becomes `paint.fill`; the rest are reported.                                                                                                                                                                                                                                                                                                                                                  |
| `background-size` / `-position` / `-repeat` | approximated | `background-positioning-ignored`       | Images are fitted to the node's frame.                                                                                                                                                                                                                                                                                                                                                                             |
| Text with mixed inline styling              | approximated | —                                      | Runs are extracted for direct text children and single-level inline children. Deeper inline nesting collapses to the outer style and is reported.                                                                                                                                                                                                                                                                  |
| `line-height: normal`                       | approximated | —                                      | Resolved as `font-size × 1.2`. The real value depends on font metrics the DOM does not expose.                                                                                                                                                                                                                                                                                                                     |
| `letter-spacing: normal`                    | approximated | —                                      | Resolved as `0`.                                                                                                                                                                                                                                                                                                                                                                                                   |
| Cross-hierarchy paint order                 | approximated | —                                      | `stackingOrder` is computed with proper hoisting of positioned descendants, so the _numbers_ are right. The scene _tree_, however, mirrors the DOM so that the Illustrator layer palette stays readable. Where the two disagree — a deeply nested positioned element that CSS paints above a later sibling subtree — the layer nesting follows the DOM and the correct order is available only in `stackingOrder`. |
| `z-index: -1` children                      | approximated | —                                      | A negative-z child paints _behind its own parent's background_ in CSS. `stackingOrder` records that faithfully (the child's index is lower than its parent's), but an Illustrator child always sits inside its parent group and therefore above the parent's fill. The `fixtures/stacking` scene is the worked example.                                                                                            |
| Pseudo-elements on text elements            | approximated | `pseudo-element-merged-into-text`      | Where the parent is a text node, `::before` / `::after` content is folded into its runs rather than emitted as a separate node — a pseudo-element has no geometry, so a separate text frame would land exactly on top of the parent's. Merging keeps one frame with the characters in the right order.                                                                                                             |
| Fractional device pixels / `dpr > 1`        | approximated | —                                      | Geometry is captured in CSS pixels; `dpr` is recorded in `source.viewport` but not applied. Raster assets keep their intrinsic resolution.                                                                                                                                                                                                                                                                         |

### Assets

| Feature                                    | Status       | Reason code          | Notes                                                                                                                                      |
| ------------------------------------------ | ------------ | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| CORS-restricted images                     | approximated | `asset-fetch-failed` | Fetched through the service worker, which is not bound by page CORS. If that also fails, the node keeps its frame and reports the failure. |
| `<canvas>` tainted by cross-origin content | unsupported  | `canvas-tainted`     | `toDataURL` throws; the node degrades to a box.                                                                                            |
| Assets above `capture.maxAssetBytes`       | unsupported  | `asset-too-large`    | Configurable in `config/web2ai.config.json`.                                                                                               |
| `srcset` / `<picture>`                     | approximated | —                    | The currently selected source (`currentSrc`) is used.                                                                                      |

---

## Render side (Illustrator CEP panel)

> Milestones 2–5 are not implemented yet. The rows below record decisions that
> are already fixed by the architecture; they will gain reason codes as the
> renderer lands.

| Feature                      | Status       | Notes                                                                                                                                                                                                          |
| ---------------------------- | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Four different border widths | planned (M3) | Illustrator strokes a path with one width. Unequal borders become four separate paths.                                                                                                                         |
| Multiple `box-shadow`s       | planned (M3) | Only the first becomes a live Drop Shadow effect. The strategy for the rest is `render.multiShadowStrategy` in the config; the default reports them as unsupported rather than faking them.                    |
| `inset` shadows              | planned (M3) | Illustrator's Drop Shadow has no inset mode.                                                                                                                                                                   |
| Deep layer nesting           | planned (M3) | Illustrator becomes very slow with deeply nested layers. Below `render.maxLayerDepth` (default 4) the renderer switches from layers to groups. The layer palette therefore flattens past that depth by design. |
| Missing fonts                | planned (M3) | Resolved through `config/font-map.json`, then by family name, then `render.defaultFontFallback`. Every substitution is collected and reported — never silent.                                                  |
| Web fonts                    | planned (M3) | web2ai does not install fonts. A web font that is not present on the system is a reported substitution.                                                                                                        |
| Text as outlines             | planned (M3) | Available as a capture option; converts text after placement, losing editability.                                                                                                                              |

---

## Reporting

Every reason code above appears in `SceneNode.unsupportedReasons` and is
aggregated into the import report (milestone 4), which the panel displays and
can export as Markdown. If you find behaviour that is degraded but _not_
reported, that is a bug — please open an issue.
