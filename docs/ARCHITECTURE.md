# web2ai architecture

web2ai reconstructs a rendered web page as a structured, layered Adobe
Illustrator document. It is two programs that never talk to each other
directly, plus one format that both of them agree on.

```
┌──────────────────────────┐        ui-scene@1 JSON        ┌───────────────────────────┐
│  Chrome extension (MV3)  │  ───────────────────────────► │  Illustrator CEP panel    │
│                          │   POST http://127.0.0.1:8787  │                           │
│  content/  DOM walk      │   (fallback: chrome.downloads)│  node/    HTTP receiver   │
│  lib/      CSS parsers   │                               │  client/  panel UI        │
│  background/ asset fetch │                               │  host/    ExtendScript    │
│  popup/    options UI    │                               │           renderer        │
└──────────────────────────┘                               └───────────────────────────┘
```

## Why CEP and ExtendScript, not UXP

UXP is not publicly available for Illustrator. There is no `require("illustrator")`
and no UXP manifest that Illustrator will load from a third party. The supported
extensibility surface for a third-party Illustrator panel is **CEP 11**
(Illustrator CC 2021 / 25.0 and newer) with **ExtendScript** as the host layer.
That is what this project targets, and it is not negotiable without Adobe
shipping public UXP support for Illustrator.

Consequences that shape everything downstream:

- **ExtendScript is ES3.** No `let`, no `const`, no arrow functions, no native
  `JSON`, no `Array.prototype.forEach`, no `String.prototype.trim`. A single
  ES5+ token anywhere in the host bundle makes the _whole_ bundle fail to parse
  and `evalScript` returns the useless string `"EvalScript error."`. The repo
  guards this two ways: `eslint.config.js` parses `apps/cep-extension/host/**`
  with `ecmaVersion: 3`, and the host bundle is assembled by concatenation so
  the shipped file is byte-for-byte the file that was linted.
  `host/lib/json2.js` (Crockford, public domain) supplies `JSON`.
- **Payloads never travel through `evalScript`.** `evalScript` takes a _source
  string_. Interpolating a multi-megabyte scene into it would hit the parser's
  limits and break on any stray quote or U+2028. Instead the Node side writes
  the scene to a temp file and `evalScript` carries only the path; the host
  reads the file itself (`host/10-io.jsx`).
- **Node must be switched on in the manifest.** `CSXS/manifest.xml` passes
  `--enable-nodejs` and `--mixed-context` via `CEFCommandLine`. Without them
  there is no `require` in the panel and no transport server.

## Coordinate system and units

`ui-scene@1` is expressed entirely in **DOM terms**: origin at the top-left of
the captured document, x to the right, y **downwards**, in CSS pixels, absolute
to the document (not the viewport).

Illustrator's artboard has its origin at the top-left with y growing _upwards_,
so the renderer — and only the renderer — applies:

```
x_ai = x_dom
y_ai = -y_dom
```

Sizes are emitted 1 CSS px → 1 pt. This is the classic 72 dpi assumption: it is
_not_ physically faithful (a CSS pixel is 1/96 in, a point is 1/72 in, so the
document comes out 4/3 larger than the page would print), but it keeps every
number in the scene identical on both sides and round-trips exactly. The ratio
lives in `config/web2ai.config.json` as `render.pointsPerCssPixel` for anyone
who wants the physically correct `0.75`.

## Paint order and layer order

Two orderings are in play and they run opposite ways:

- **`ui-scene@1`**: `children` is **back-to-front**. `children[0]` is painted
  first and therefore sits _behind_ `children[n]`. `stackingOrder` is a global,
  monotonically increasing index over the whole scene in resolved CSS paint
  order — explicitly **not** DOM order.
- **Illustrator**: `layers[0]` / `pageItems[0]` is the **topmost** element.

So the renderer inserts children **in reverse**. Getting this backwards is the
single most common way to produce a document that looks like noise, so it is
stated here, restated in `packages/schema/src/types.ts`, and covered by tests.

`stackingOrder` is computed by `apps/chrome-extension/src/lib/stacking.ts`,
which implements CSS 2.1 Appendix E painting order plus the modern stacking
context triggers (`opacity < 1`, `transform`, `filter`, `will-change`,
`mix-blend-mode`, `isolation`, `contain`, `position: fixed/sticky`). Positioned
descendants that do not themselves form a stacking context are _hoisted_ into
their nearest ancestor stacking context, which is what makes a `z-index: 10`
overlay land above a later sibling's background. The scene tree still mirrors
the DOM hierarchy — hoisting affects the numbers, not the nesting — because a
readable layer palette is worth more than a perfectly flattened paint list. See
`docs/LIMITATIONS.md` for the case where those two goals disagree.

## The format: `ui-scene@1`

`packages/schema` is the single source of truth. It exports:

- `types.ts` — the TypeScript types, with the coordinate and ordering contract
  written down next to them.
- `validator.ts` — zod schemas. **Both sides validate**: the capture side
  validates what it produces before sending, the Illustrator side validates
  what it receives before rendering. A malformed scene fails at the boundary
  where it can still be reported, not halfway through building a document.
- `json-schema.ts` — a JSON Schema projection (`pnpm --filter @web2ai/schema build`
  writes `ui-scene.schema.json`) for non-TypeScript consumers.
- `config.ts` — typed, validated access to `config/`.

Version is pinned in the payload (`version: 1`). A future incompatible change
gets `version: 2` and an explicit migration, never a silent reinterpretation.

### Extensions to the base outline

These fields extend the original schema sketch. They are additive and optional,
and each earns its place:

| Field                             | Why                                                                                                 |
| --------------------------------- | --------------------------------------------------------------------------------------------------- |
| `Scene.source.document`           | The artboard height comes from the full scroll size, which is not derivable from the viewport.      |
| `Scene.options`                   | The import report needs to state what was asked for.                                                |
| `SceneNode.cssPosition`           | `fixed`/`sticky` need distinct handling and reporting.                                              |
| `SceneNode.transformOrigin`       | A matrix without its origin cannot be reproduced.                                                   |
| `Stroke.colors` / `Stroke.styles` | CSS borders are per-side; a single colour loses real information that the four-path renderer needs. |
| `TextRun.decoration`              | Underlines are cheap to carry and expensive to guess.                                               |
| `FontRef.stack`                   | Lets the host try later families before falling back blindly.                                       |

## Configuration

Everything tunable lives in `config/`:

- `config/web2ai.config.json` — transport port and fallback range, capture
  defaults, render limits (`maxLayerDepth`), debug port, log level.
- `config/font-map.json` — CSS family + weight/style → Illustrator font name.

Nothing else may hardcode these values. TypeScript reads them through
`@web2ai/schema/config` (validated with zod at load time, so a typo in the JSON
is a loud error, not a mystery). The ExtendScript host cannot import
TypeScript, so the build copies `config/` into the extension root and
`host/10-io.jsx` reads the same JSON files from disk.

## Build layout

`apps/cep-extension/scripts/build.mjs` assembles an installable extension:

```
apps/cep-extension/dist/
├── .debug              generated; enables remote debugging on the configured port
├── CSXS/manifest.xml
├── client/             Vite build of the panel (single classic IIFE — see below)
├── config/             copy of the repo-root config/
└── host/index.jsx      json2.js + host/*.jsx concatenated in filename order
```

Two non-obvious details:

- The panel is built as a **classic IIFE script with `defer`**, not an ES
  module. CEP loads the panel from a `file://` URL and Chromium refuses to
  fetch ES modules across an opaque origin; `defer` replaces the deferred
  execution that `type="module"` used to provide.
- The host bundle is **concatenated, not `#include`d**. ExtendScript's
  preprocessor would work, but concatenation means the shipped file is exactly
  the linted file and nothing resolves paths at runtime.

`scripts/dev-install.mjs` symlinks `dist/` into the per-user CEP extensions
directory and sets `PlayerDebugMode`. It is one cross-platform script rather
than a `.sh`/`.ps1` pair so the platforms cannot drift.

## Testing strategy

The hard parts are pure functions, and they are tested as pure functions:

- **CSS parsers** (`lib/css/*`) take strings and return schema values. No DOM.
- **Stacking order** (`lib/stacking.ts`) takes a tree of plain style records
  and returns a paint order. No DOM.
- **The DOM walker** talks to a narrow `CaptureEnv` interface
  (`getComputedStyle`, `getRect`, and a few hooks) rather than to global
  `window`. Tests drive it with a synthetic DOM, so walker behaviour —
  skip rules, text-run detection, depth limits, pseudo-elements — is testable
  without a browser and without layout.
- **Fixtures** in `fixtures/` are real HTML pages with committed expected
  scenes, validated against the schema.

The ExtendScript renderer (milestone 3) gets the same treatment: its geometry
and colour helpers are written so they can run against a fake Illustrator DOM.
