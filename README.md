# dsh-ui-polish

[English](README.md) | 中文

A collection of small **usability fixes for the DeepSeek Harness Web GUI**,
packaged as one plugin: one build, one settings namespace, one release, and one
switch per fix so any of them can be turned off without uninstalling anything.

This is a third-party [dsh](https://github.com/deepseek-ai/deepseek-harness)
profile bundle. It ships as one dual-face package: a Node half that owns the
durable settings namespace, and a browser half that installs the fixes and
registers the Settings row.

Requires dsh `0.1.5-rc.1` or a later `0.1.5-rc.x`; it uses the
`settings.general.item` slot, the `settingsScope` service, and `ctx.effect`,
which are present in the `latest` and `next` release channels.

## What it adds

An **Interface polish** row in *Settings → General*, listing every fix in the
package with a switch. Every fix defaults to **on**: a fix exists because the
shipped behaviour is wrong, so making the user opt in would ship the bug and hide
the cure. The switches are there to get out of the way, not to advertise the
package.

| Fix | What it does | Default |
| --- | --- | --- |
| Wheel passes through the conversation width handles | The wheel scrolls the transcript even when the pointer is over the invisible resize strip in either gutter | On |

## The first fix: the dead wheel over the width handles

The transcript has a resize handle in each gutter. It is up to 40px wide, it is
*fully transparent* until the pointer is over it, and it swallows the wheel: park
the pointer on it, scroll, and the transcript does not move. Nothing on screen
explains why, which is what makes it read as a bug rather than a boundary.

The cause is structural. The handle is an absolutely positioned overlay *beside*
the scrolling element, not inside it:

```
.body (position: relative)
├─ .scrollBody [data-conversation-scroll]   ← the element that actually scrolls
├─ div [data-width-handle="left"]           ← overlay, no background
└─ div [data-width-handle="right"]          ← overlay, no background
```

A wheel event that lands on the strip walks up an ancestor chain that contains no
user-scrollable box — `overflow: hidden` is a scroll container that the wheel
never scrolls — and dies there. The scroller is a *sibling*, so it is never
reached.

With the fix on, the plugin takes the wheel at the document (capture phase) and,
only when it lands on one of those strips, hands the same delta to whatever is
really underneath it — found by asking the document what is at that point with
the strip skipped, so nothing depends on a DOM shape a dsh release could
rearrange.

What it deliberately does **not** do:

- **No layout change.** The strips keep their size, their drag, and their hover
  indicator. Only the wheel is bridged.
- **No interference elsewhere.** An event that does not land on a strip is
  returned untouched; scrolling the transcript, the sidebars, or any dialog in the
  interface behaves exactly as before.
- **No swallowed gestures.** <kbd>Ctrl</kbd>+wheel stays the browser's zoom.
- **No dead ends.** At the top or bottom of the transcript the event is left
  alone, so the browser's own scroll chaining still applies — the strip cannot
  become a *different* dead zone.

If it ever misbehaves on some layout, turn it off in *Settings → General →
Interface polish* — no reinstall, no waiting for a release.

## Install

```sh
dsh plugin --profile web add @citisen/dsh-ui-polish
```

Or straight from GitHub (same package, not via the registry):

```sh
dsh plugin --profile web add github:citisen/dsh-ui-polish
```

Then restart the Web interface:

```sh
dsh --profile web
```

`dsh plugin` forwards to pnpm inside the profile directory and then reconciles
`dsh.profile.bundles`; because this package declares `dsh.bundle`, installing it
appends the layer automatically, with no hand edit to `cordis.patch.yml`.

### Installing from a local checkout

On Windows, when the profile and the checkout are on **different drives**,
`dsh plugin --profile web add <path>` is unreliable: pnpm resolves the link to a
path that does not exist, so the reconciler decides the package declares no
`dsh.bundle` and leaves it out of `bundles`. (The same thing happens on one drive
sometimes — verify the link, do not assume.) Create the link yourself:

```sh
cd "$DSH_HOME/profiles/web"
pnpm add "D:/path/to/dsh-ui-polish"      # writes the dependency
# pnpm's link points at <profile>/D:/path/... which does not exist; replace it:
cmd /c rmdir node_modules\@citisen\dsh-ui-polish
cmd /c mklink /J node_modules\@citisen\dsh-ui-polish D:\path\to\dsh-ui-polish
# then add "@citisen/dsh-ui-polish" to dsh.profile.bundles in package.json
```

Check the result with `node scripts/verify-profile.mjs`: if the row is missing
from the composed entry list, it fails loudly.

## Development

```sh
npm run build     # src/client.js -> lib/client.js
npm run check     # the release gate: artifacts in sync + host and client halves
npm run check:all # plus a real profile composition check (needs a local dsh)
npm run verify    # just the verification scripts
npm run watch     # rebuild on save, for dsh-client-hmr
```

`src/client.js` is the only source of the browser half. It is written as an ES
module for readability, but a DSH client bundle is a **classic script** that may
only register a lazy CommonJS factory through `window.__ModuleLoader__`, so
`scripts/build-client.mjs` applies that envelope and rewrites the static imports.
The transformation is deliberately narrow and fails loudly on any form it cannot
express — including a static import it did not rewrite, which would otherwise
reach the browser as an ES import inside a classic script and simply never load.

### Adding a fix

One entry in `FIXES` in `src/client.js`: an id, two locale keys, and an
`install(ctx)` returning its own disposer. The Settings row is generated from
that list, and the applicator installs exactly the enabled fixes and disposes
them when their switch goes off — so a fix needs nothing else, and one fix
failing to install cannot take the others down.

The id is also the settings key, and the host half's schema is built from the
same list. The two halves are separate bundles and cannot share a module, so the
list is duplicated by hand; `verify-client.mjs` compares the two copies, which
turns a silent drift into a failing check.

Name a fix for the behaviour the user gets (`wheelThroughWidthHandle`), not for
the component it patches, because the id ends up in bug reports.

## Package layout

| Path | What it is |
| --- | --- |
| `lib/index.js` | Node half: the settings namespace. Loaded by the loader. |
| `lib/client.js` | Browser half, **generated from `src/client.js`** and served to the GUI. |
| `src/client.js` | Browser half source: the fix registry, the fixes, the row. |
| `cordis.patch.yml` | The profile layer this bundle contributes. |
| `scripts/` | Build and verification scripts. |
| `PUBLISHING.md` | Trusted publishing: the setup, and what it does not protect against. |
| `RELEASING.md` | The runbook for shipping a change. |

## Known limitations

- **Only the conversation's two handles are matched.** They are matched by
  `[data-width-handle]`, with the component's CSS-module class as a fallback.
  The frame's own 8px column handles are deliberately *not* matched: they are
  visible to the user and are not reported as swallowing the wheel.
- **A dsh release can turn the fix into a no-op.** If the attribute or the class
  name disappears, nothing matches, no event is taken over, and the plugin
  quietly does nothing — the bug returns, nothing breaks. That is the intended
  failure mode; the durable cure is upstream, in `ui-conversation` itself.
- **Vertical deltas only.** A horizontal wheel over a strip is not forwarded
  anywhere, because there is nothing horizontal to scroll there.
- **Line and page deltas are approximated.** A `deltaMode` of lines uses the
  scroller's computed line height (16px when that is unavailable), and pages use
  its client height. Pixel deltas — what a normal mouse and trackpad report — are
  forwarded exactly.
- **The wheel is scrolled, not re-dispatched.** A synthetic wheel event cannot
  start a native scroll, so the bridge sets `scrollTop` itself. Smooth-scrolling
  preferences are therefore the target element's business, not the plugin's.
- **The settings row is English/Chinese only**, matching the shipped locale pair.

## License

MIT
