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

On Windows, install a copy rather than a link — CEP's scanner does not reliably
follow reparse points:

```bash
pnpm dev:install --copy
```

This places `apps/cep-extension/dist` in your per-user CEP extensions directory
and enables `PlayerDebugMode` so Illustrator will load an unsigned panel:

|         |                                                                                                              |
| ------- | ------------------------------------------------------------------------------------------------------------ |
| macOS   | `~/Library/Application Support/Adobe/CEP/extensions/` + `defaults write com.adobe.CSXS.11 PlayerDebugMode 1` |
| Windows | `%APPDATA%\Adobe\CEP\extensions\` + `HKCU\Software\Adobe\CSXS.11` → `PlayerDebugMode = 1`                    |

Then restart Illustrator and open **Window ▸ Extensions ▸ web2ai**.

Two things are **off by default**, because both are among the handful of
differences that can stop CEP from listing a panel at all, and having them as
one-flag rebuilds makes them quick to rule out:

```bash
pnpm --filter @web2ai/cep-extension build -- --enable-node   # Node inside the panel (milestone 2 needs this)
pnpm --filter @web2ai/cep-extension build -- --debug-file    # remote debugging on http://localhost:8088
```

`pnpm dev:install --uninstall` removes the link. `--copy` installs a copy
instead of a symlink; `--csxs=11,12,13` targets other CEP runtimes.

#### The panel does not appear under Window ▸ Extensions

CEP fails silently — it never reports why it dropped an extension. Run the
diagnostic, which walks the whole chain and names the first thing that is
wrong:

```bash
pnpm dev:doctor
```

If you have another extension that Illustrator _does_ list, point the doctor at
it — a working manifest is the fastest way to find the offending field:

```bash
pnpm dev:doctor --reference "C:\path\to\WorkingExtension"
```

The three usual causes, in order of how often they bite:

1. **An incomplete build.** If `MainPath` or `ScriptPath` does not resolve, CEP
   skips the extension without a word. A build that failed partway through
   leaves a folder that looks perfectly normal. `pnpm dev:install` now refuses
   to install one, and the doctor points straight at the missing file.
2. **PlayerDebugMode is off for the runtime Illustrator actually uses.** It is
   per CSXS version: newer releases run on CSXS 12 and read a different
   registry key than CSXS 11. `pnpm dev:install` sets both; use `--csxs` if
   your version needs another.
3. **The symlink.** On Windows, CEP's scanner does not reliably follow reparse
   points. `pnpm dev:install --copy` installs a real folder — at the cost of
   having to reinstall after each rebuild.
4. **`RequiredRuntime`.** It is a _minimum_, and CEP checks it before anything
   else. Declaring a CSXS revision higher than the host reports drops the
   extension silently. web2ai declares 9.0 for that reason; the Illustrator
   version requirement is carried by the `<Host>` range instead.
5. **An XML comment before `<ExtensionManifest>`.** CEP's manifest reader is
   stricter than a general XML parser. Comments inside the root element are
   fine; one before it is not. Same for `.debug`.

`docs/ARCHITECTURE.md` has the full table of these constraints and what each
one costs.

Illustrator only scans at startup, so quit it completely between attempts.

### Chrome extension

```bash
pnpm --filter @web2ai/chrome-extension build
```

Then in Chrome: **`chrome://extensions`** → enable _Developer mode_ → **Load
unpacked** → select `apps/chrome-extension/dist`.

## Development

```bash
pnpm test         # vitest: CSS parsers, stacking order, walker, schema, fixtures
pnpm typecheck    # tsc across every package
pnpm lint         # eslint, incl. an ES3-only pass over the ExtendScript host
pnpm format       # prettier
```

### Fixtures

`fixtures/` holds real HTML pages together with the scene each one should
produce. The expected scenes are generated by running the actual walker inside
Chromium, so they check the parsers against what a browser really computes —
not against a mock:

```bash
pnpm --filter @web2ai/chrome-extension build   # the harness uses dist/capture-standalone.js
pnpm fixtures                                  # regenerate fixtures/*/expected-scene.json
pnpm fixtures:check                            # fail if they are out of date
```

`pnpm test` only reads the committed scenes, so the regular test run needs no
browser. Chromium is located via `PLAYWRIGHT_BROWSERS_PATH`, or set
`WEB2AI_CHROMIUM` to a binary of your choice.

`dist/capture-standalone.js` is also handy on its own: paste it into a DevTools
console on any page and call `__web2aiCapture()` to see what the walker makes
of it.

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
