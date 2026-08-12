# web2ai

Reconstruct any website's UI as a **structured, layered Adobe Illustrator
document** — not a screenshot, not a flat trace: real rectangles, real text
frames, real placed images, in a layer palette that mirrors the DOM.

Two components, one repo:

- **`apps/chrome-extension`** — an MV3 extension that walks the rendered DOM and
  serialises it into `ui-scene@1`.
- **`apps/cep-extension`** — a CEP 11 panel for Illustrator that receives a
  scene and builds the document.

They are decoupled by [`packages/schema`](packages/schema), the versioned JSON
format both sides validate against.

> **Status:** milestones 0 and 1 are implemented (scaffold + capture). The
> transport and the Illustrator renderer are milestones 2–5. See
> [`docs/LIMITATIONS.md`](docs/LIMITATIONS.md) for exactly what does and does
> not work — it is kept honest.

## Requirements

- Node 20+ and pnpm 10+
- Google Chrome (or any Chromium with MV3)
- Adobe Illustrator CC 2021 (25.0) or newer, on macOS or Windows

## Setup

```bash
pnpm install
pnpm build
```

### Illustrator panel

```bash
pnpm dev:install
```

This symlinks `apps/cep-extension/dist` into your per-user CEP extensions
directory and enables `PlayerDebugMode` so Illustrator will load an unsigned
panel:

|         |                                                                                                              |
| ------- | ------------------------------------------------------------------------------------------------------------ |
| macOS   | `~/Library/Application Support/Adobe/CEP/extensions/` + `defaults write com.adobe.CSXS.11 PlayerDebugMode 1` |
| Windows | `%APPDATA%\Adobe\CEP\extensions\` + `HKCU\Software\Adobe\CSXS.11` → `PlayerDebugMode = 1`                    |

Then restart Illustrator and open **Window ▸ Extensions ▸ web2ai**. Remote
debugging is available at <http://localhost:8088> while the panel is open.

`pnpm dev:install --uninstall` removes the link. `--copy` installs a copy
instead of a symlink; `--csxs=11,12` targets other CEP runtimes.

### Chrome extension

```bash
pnpm --filter @web2ai/chrome-extension build
```

Then in Chrome: **`chrome://extensions`** → enable _Developer mode_ → **Load
unpacked** → select `apps/chrome-extension/dist`.

## Development

```bash
pnpm test         # vitest: CSS parsers, stacking order, walker fixtures, schema
pnpm typecheck    # tsc across every package
pnpm lint         # eslint, incl. an ES3-only pass over the ExtendScript host
pnpm format       # prettier
```

## How it works

The short version: the Chrome side resolves CSS paint order properly (stacking
contexts, not DOM order), extracts geometry, fills, strokes, shadows, text runs
and assets into a flat, explicit JSON document; the Illustrator side turns that
into layers, paths, text frames and placed items, converting DOM coordinates
(y down) into artboard coordinates (y up).

The long version, including why this is CEP + ExtendScript rather than UXP, why
payloads never go through `evalScript`, and how paint order is resolved:
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Configuration

Everything tunable lives in [`config/`](config/) — transport port, capture
defaults, layer depth limit, font mapping, skip selectors. Nothing is
hardcoded elsewhere.

## License

MIT
