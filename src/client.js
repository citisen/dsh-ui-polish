/**
 * Browser half of `dsh-ui-polish` — a collection of small usability fixes for
 * the DeepSeek Harness Web GUI, each switchable on its own from Settings.
 *
 * This file is NOT loaded as an ES module. `scripts/build-client.mjs` wraps it
 * in the DSH client-bundle envelope and writes `lib/client.js`, which is what
 * the Web shell fetches. Keep it dependency-light: the only modules it may
 * `import` are the platform-singleton specifiers the shell seeds into its module
 * table.
 *
 * Why a collection
 * ----------------
 * These fixes all have the same shape — the shipped interface does something
 * slightly hostile to the pointer or the keyboard, and the cure is a hooked
 * listener plus a switch to turn it off — so they share one package, one build,
 * one settings namespace and one release instead of becoming a row of
 * single-purpose plugins nobody wants to install.
 *
 * Adding a fix
 * ------------
 * One entry in {@link FIXES}: an id (which is also its settings key), two locale
 * keys, and an `install(ctx)` that returns its own disposer. The settings row is
 * generated from that list and the applicator reinstalls exactly the enabled
 * ones whenever a switch moves, so a fix needs nothing else — and a fix that
 * misbehaves in some layout can be turned off from the UI rather than requiring
 * a new release.
 *
 * The host half's schema is built from the same ids, kept in sync by hand
 * because the two halves are separate bundles; `scripts/verify-client.mjs`
 * asserts the two lists agree.
 *
 * @module dsh-ui-polish/client
 */

import React from 'react'
import { defineStore } from '@deepseek-ai/dsh-client-store'

/** Settings namespace owned by this plugin (mirrors the host half). */
const POLISH_NAMESPACE = 'ui-polish'
/** Locale namespace owning this feature's settings-row copy. */
const LOCALE_NAMESPACE = 'settings.uiPolish'
/** Cosmetic namespace for this plugin's CSS classes. */
const STYLE_PREFIX = 'dsh-polish'
/**
 * The plugin's identity, substituted with the real package name by
 * `scripts/build-client.mjs`. It tags the stylesheet this plugin owns and heads
 * its diagnostics, so a bundle mounted under another name says so.
 */
const PLUGIN_ID = /* dsh:plugin-id */ 'dsh-ui-polish'

// ─── fix 1: the wheel passes through the conversation width handles ──────────
//
// The transcript offers two resize handles — one in each gutter — as absolutely
// positioned overlays inside the conversation body, up to 40px wide, and painted
// with nothing at all until the pointer is over them:
//
//   .body (position: relative)
//   ├─ .scrollBody [data-conversation-scroll]   ← the element that scrolls
//   ├─ div [data-width-handle="left"]           ← overlay, no background
//   └─ div [data-width-handle="right"]          ← overlay, no background
//
// The strip is a SIBLING of the scroller, not a descendant of it, so a wheel
// event landing on the strip walks up an ancestor chain that holds no
// user-scrollable box — `overflow:hidden` is a scroll container that the wheel
// never scrolls — and dies there. The transcript does not move, and nothing on
// screen explains why: the big hit area is invisible until hovered, which is
// exactly what makes the dead wheel feel like a bug rather than a boundary.
//
// This fix removes the dead zone without touching the handles: their size is the
// point of them, and their drag needs the pointer events they already get. What
// it does instead is take the wheel at the document and, only when it lands on
// one of those strips, hand the same delta to whatever is really underneath.
// That target is found by asking the document what is at the pointer with the
// strip skipped, so nothing here depends on a layout a dsh release could
// rearrange — and if the strips ever disappear, the fix simply stops matching
// and does nothing at all.

/**
 * The two strips, and nothing else.
 *
 * `data-width-handle` is set by `ui-conversation`'s `WidthHandle` component; the
 * class fallback is that component's CSS-module name, which is unique to it.
 * Both are deliberately narrow: the frame's own 8px column handles are NOT
 * matched, because those are visible to the user and are not reported as
 * swallowing the wheel.
 */
const HANDLE_SELECTOR = '[data-width-handle],[class*="widthHandle"]'

/** Whether a DOM node is an element, so the computed-style read is safe. */
function isElement(node) {
  return node !== null && typeof node === 'object' && node.nodeType === 1
}

/**
 * The strip a wheel event landed on, if it landed on one.
 * @param target - the event target.
 * @returns the strip element, or undefined.
 */
function handleFromTarget(target) {
  if (target === null || target === undefined) return undefined
  if (typeof target.closest !== 'function') return undefined
  return target.closest(HANDLE_SELECTOR) ?? undefined
}

/**
 * The nearest node that the user can actually scroll, the node itself included.
 *
 * `overflow: hidden` is deliberately not eligible: it is a scroll container as
 * far as the CSSOM is concerned, but the wheel does not scroll it, so treating
 * it as a target would move the dead zone rather than remove it.
 * @param node - where to start walking up.
 * @returns the scrollable element, or undefined.
 */
function nearestScroller(node) {
  if (typeof getComputedStyle !== 'function') return undefined
  let element = node
  while (isElement(element)) {
    const overflowY = getComputedStyle(element).overflowY
    if ((overflowY === 'auto' || overflowY === 'scroll') && element.scrollHeight > element.clientHeight) {
      return element
    }
    element = element.parentElement
  }
  return undefined
}

/**
 * A wheel delta in pixels.
 *
 * The DOM reports deltas in three units, and only the pixel one may be used
 * as-is. `metrics` is called lazily because the common case is pixels: with a
 * pixel delta nothing has to be measured at all, and a wheel handler that reads
 * layout on every event is a wheel handler that stutters.
 *
 * @param deltaY - the event's vertical delta.
 * @param deltaMode - 0 = pixels, 1 = lines, 2 = pages.
 * @param metrics - `() => ({ lineHeight, pageHeight })`, called only when needed.
 * @returns the delta in pixels; 0 when there is nothing to do.
 */
function wheelPixels(deltaY, deltaMode, metrics) {
  if (!Number.isFinite(deltaY) || deltaY === 0) return 0
  if (deltaMode === 1) {
    const lineHeight = metrics().lineHeight
    return deltaY * (Number.isFinite(lineHeight) && lineHeight > 0 ? lineHeight : 16)
  }
  if (deltaMode === 2) {
    const pageHeight = metrics().pageHeight
    return deltaY * (Number.isFinite(pageHeight) && pageHeight > 0 ? pageHeight : 0)
  }
  return deltaY
}

/**
 * Whether a scroller has room for this delta in the direction it points.
 *
 * A half-pixel of slack keeps a fractional `scrollTop` at the end of the range
 * from being reported as room, which would swallow the event and leave the wheel
 * doing nothing at the very moment the user expects the page to take over.
 * @param scroller - the candidate scroll container.
 * @param pixels - the delta in pixels.
 * @returns whether scrolling it would move anything.
 */
function canScroll(scroller, pixels) {
  if (pixels === 0) return false
  const room = scroller.scrollHeight - scroller.clientHeight
  if (!(room > 0)) return false
  return pixels > 0 ? scroller.scrollTop < room - 0.5 : scroller.scrollTop > 0.5
}

/**
 * The whole decision behind the bridge, with every DOM read injected so the
 * behaviour can be tested in Node instead of only by hand in a browser.
 *
 * Returning `undefined` is the common and important case: it means "not ours" or
 * "nothing to give", and the event is left completely alone, so the browser's
 * own scroll chaining still works.
 *
 * @param event - `{ target, clientX, clientY, deltaY, deltaMode, ctrlKey }`.
 * @param dom - `{ handleFrom, elementsAt, scrollerFrom, metricsFor }`.
 * @returns `{ scroller, pixels }`, or undefined to leave the event alone.
 */
function wheelPlan(event, dom) {
  // Ctrl+wheel is the browser's zoom gesture in every browser that has one.
  if (event.ctrlKey === true) return undefined
  const handle = dom.handleFrom(event.target)
  if (handle === undefined) return undefined
  if (!Number.isFinite(event.deltaY) || event.deltaY === 0) return undefined

  // What is under the pointer once the strip is ignored. The strip overlays the
  // transcript's own scroller, so this is normally that scroller — but nothing
  // here assumes it: whatever is found is walked up to its first scroller.
  const under = dom
    .elementsAt(event.clientX, event.clientY)
    .filter((element) => element !== handle && !handle.contains(element))

  for (const element of under) {
    const scroller = dom.scrollerFrom(element)
    if (scroller === undefined) continue
    const pixels = wheelPixels(event.deltaY, event.deltaMode, () => dom.metricsFor(scroller))
    // At either end of the range there is nothing to give, so the event is left
    // for the browser to chain — the alternative is a strip that swallows the
    // wheel at the top of the transcript as well.
    if (!canScroll(scroller, pixels)) continue
    return { scroller, pixels }
  }
  return undefined
}

/** The real DOM reads the bridge uses; separate so tests can hand in stubs. */
const WHEEL_DOM = {
  handleFrom: handleFromTarget,
  elementsAt: (x, y) =>
    typeof document.elementsFromPoint === 'function' ? document.elementsFromPoint(x, y) : [],
  scrollerFrom: nearestScroller,
  metricsFor: (scroller) => {
    const lineHeight = Number.parseFloat(getComputedStyle(scroller).lineHeight)
    return { lineHeight, pageHeight: scroller.clientHeight }
  },
}

/**
 * Install the wheel bridge.
 * @returns a disposer that removes the listener again.
 */
function installWheelThrough() {
  if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') {
    return () => {}
  }
  const onWheel = (event) => {
    const plan = wheelPlan(
      {
        target: event.target,
        clientX: event.clientX,
        clientY: event.clientY,
        deltaY: event.deltaY,
        deltaMode: event.deltaMode,
        ctrlKey: event.ctrlKey,
      },
      WHEEL_DOM,
    )
    if (plan === undefined) return
    event.preventDefault()
    plan.scroller.scrollTop += plan.pixels
  }
  // Capture phase, so nothing between the document and the strip can consume the
  // event first, and non-passive, because taking it over means cancelling it.
  document.addEventListener('wheel', onWheel, { capture: true, passive: false })
  return () => {
    document.removeEventListener('wheel', onWheel, { capture: true })
  }
}

// ─── the fix registry ───────────────────────────────────────────────────────

/**
 * Every fix this plugin carries, in the order the settings row lists them.
 *
 * A fix's `id` is its settings key, its localStorage-free state, and the word a
 * bug report will use, so it is named for the behaviour rather than the
 * component: `wheelThroughWidthHandle` says what the user gets, not where the
 * code lives.
 */
const FIXES = [
  {
    id: 'wheelThroughWidthHandle',
    labelKey: 'uiPolish.fix.wheel',
    hintKey: 'uiPolish.fix.wheelHint',
    install: installWheelThrough,
  },
]

/** Every fix starts on: this plugin exists to be used, not to be configured. */
const FIX_DEFAULTS = Object.fromEntries(FIXES.map((fix) => [fix.id, true]))

// ─── the settings row ───────────────────────────────────────────────────────

/** Row copy, keyed by locale. `zh` is the key-set source of truth. */
const zh = {
  'uiPolish.title': '界面润色',
  'uiPolish.description': '针对 Web 界面的一小组可用性修正；每一项都可以单独关掉',
  'uiPolish.fix.wheel': '滚轮穿过对话两侧的调宽手柄',
  'uiPolish.fix.wheelHint':
    '对话左右各有一条几十像素宽、平时完全透明的调宽手柄，它盖在正文滚动区上方却不是它的子元素，所以鼠标停在上面时滚轮不会滚动正文。开启后滚轮会转交给手柄下面真正能滚动的那一层；手柄的热区和拖拽手感完全不变。',
  'uiPolish.on': '已开启',
  'uiPolish.off': '已关闭',
  'uiPolish.reset': '全部恢复默认',
}

/** English dictionary, checked complete against the `zh` key set. */
const en = {
  'uiPolish.title': 'Interface polish',
  'uiPolish.description':
    'A small set of usability fixes for the Web GUI; each one can be turned off on its own',
  'uiPolish.fix.wheel': 'Wheel passes through the conversation width handles',
  'uiPolish.fix.wheelHint':
    'The transcript has a wide, fully transparent resize handle in each gutter. It is an overlay beside the scrolling area rather than inside it, so the wheel does nothing while the pointer is over it. With this on, the wheel is handed to whatever really scrolls underneath; the handle keeps its size and its drag.',
  'uiPolish.on': 'On',
  'uiPolish.off': 'Off',
  'uiPolish.reset': 'Reset to defaults',
}

/** The stylesheet for the row's own chrome. */
const ROW_CSS = [
  '.dsh-polish-row{border-bottom:.5px solid var(--dsw-alias-border-l2);flex-direction:column;gap:16px;padding:16px 0;display:flex}',
  '.dsh-polish-head{flex-direction:column;gap:4px;display:flex}',
  '.dsh-polish-title{color:var(--dsw-alias-label-primary);font-size:14px;font-weight:400;line-height:22px}',
  '.dsh-polish-desc{color:var(--dsw-alias-label-tertiary);font-size:12px;font-weight:400;line-height:18px}',
  '.dsh-polish-item{align-items:flex-start;justify-content:space-between;gap:16px;display:flex}',
  '.dsh-polish-itemText{flex-direction:column;gap:4px;min-width:0;display:flex}',
  '.dsh-polish-itemLabel{color:var(--dsw-alias-label-primary);font-size:13px;font-weight:500;line-height:20px}',
  '.dsh-polish-itemHint{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}',
  '.dsh-polish-switchRow{align-items:center;gap:8px;flex:none;display:flex}',
  '.dsh-polish-state{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}',
  '.dsh-polish-switch{position:relative;box-sizing:border-box;width:36px;height:20px;padding:0;cursor:pointer;border:.5px solid var(--dsw-alias-border-l4);border-radius:10px;background:var(--dsw-alias-bg-module-platform);transition:background .15s ease,border-color .15s ease}',
  '.dsh-polish-switch[aria-checked="true"]{background:var(--dsw-alias-state-business-primary);border-color:transparent}',
  '.dsh-polish-knob{position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;background:var(--dsw-alias-label-primary-foreground);transition:left .15s ease}',
  '.dsh-polish-switch[aria-checked="true"] .dsh-polish-knob{left:19px}',
  '.dsh-polish-reset{align-self:flex-start;border:.5px solid var(--dsw-alias-border-l4);background:0 0;color:var(--dsw-alias-label-primary);cursor:pointer;border-radius:10px;padding:5px 12px;font-family:inherit;font-size:12px;line-height:18px}',
  '.dsh-polish-reset:hover{background:var(--dsw-alias-interactive-bg-hover)}',
].join('')

/** Install the row chrome stylesheet for the plugin's lifetime. */
function installRowStyles(ctx) {
  if (typeof document === 'undefined') return
  ctx.effect(() => {
    const tag = document.createElement('style')
    tag.dataset.plugin = PLUGIN_ID
    tag.dataset.pluginCss = `${STYLE_PREFIX}/row.css`
    tag.textContent = ROW_CSS
    document.head.appendChild(tag)
    return () => {
      tag.remove()
    }
  }, 'dsh-ui-polish: row stylesheet')
}

/** Live-state store behind the settings row: one boolean per fix. */
function createRowStore() {
  return defineStore({
    init: () => ({ ...FIX_DEFAULTS, revision: -1 }),
    actions: {
      sync: (draft, section, revision) => {
        if (revision !== undefined && revision <= draft.revision) return
        for (const fix of FIXES) draft[fix.id] = section[fix.id] !== false
        if (revision !== undefined) draft.revision = revision
      },
    },
  })
}

/**
 * One fix's row: what it does, whether it is on, and the switch that says so.
 *
 * A `role="switch"` button rather than a checkbox input, so the whole control is
 * one hit target that matches the design system's own toggles instead of the
 * platform's.
 * @param props - React props.
 * @returns the item element.
 */
function FixSwitch({ label, hint, state, checked, onToggle }) {
  return React.createElement(
    'div',
    { className: 'dsh-polish-item' },
    React.createElement(
      'div',
      { className: 'dsh-polish-itemText' },
      React.createElement('div', { className: 'dsh-polish-itemLabel' }, label),
      React.createElement('div', { className: 'dsh-polish-itemHint' }, hint),
    ),
    React.createElement(
      'div',
      { className: 'dsh-polish-switchRow' },
      React.createElement('span', { className: 'dsh-polish-state' }, state),
      React.createElement(
        'button',
        {
          type: 'button',
          role: 'switch',
          className: 'dsh-polish-switch',
          'aria-checked': checked === true,
          'aria-label': label,
          onClick: () => {
            onToggle(checked !== true)
          },
        },
        React.createElement('span', { className: 'dsh-polish-knob' }),
      ),
    ),
  )
}

/**
 * The General-settings row: one switch per fix, plus a reset.
 * @param props - composed slot props (`t`, `useStore`, and the inject actions).
 * @returns the row element tree.
 */
function UiPolishRow({ t, useStore, setField, reset }) {
  const state = useStore((snapshot) => snapshot)
  return React.createElement(
    'div',
    { className: 'dsh-polish-row' },
    React.createElement(
      'div',
      { className: 'dsh-polish-head' },
      React.createElement('div', { className: 'dsh-polish-title' }, t('uiPolish.title')),
      React.createElement('div', { className: 'dsh-polish-desc' }, t('uiPolish.description')),
    ),
    FIXES.map((fix) => {
      const checked = state[fix.id] === true
      return React.createElement(FixSwitch, {
        key: fix.id,
        label: t(fix.labelKey),
        hint: t(fix.hintKey),
        state: checked ? t('uiPolish.on') : t('uiPolish.off'),
        checked,
        onToggle: (value) => {
          setField(fix.id, value)
        },
      })
    }),
    React.createElement(
      'button',
      {
        type: 'button',
        className: 'dsh-polish-reset',
        onClick: () => {
          reset()
        },
      },
      t('uiPolish.reset'),
    ),
  )
}

/**
 * The client settings service this build binds, and the one dsh 0.1.7-alpha.1
 * replaced it with.
 *
 * Literals rather than imports: a client bundle may not import another bundle's
 * values, and a service name is a fact about the composition, not a dependency
 * of this package.
 */
const SETTINGS_SERVICE = 'settingsScope'
const REPLACEMENT_SETTINGS_SERVICE = 'configForms'

/**
 * The snapshot a scope reports when there is nothing to report.
 *
 * Shape-for-shape the one a bound scope answers with when the Host itself keeps
 * settings process-local — a non-loopback page: no value, nothing writable. The
 * row already paints its defaults for that state, which is why "settings
 * refused" and "no settings service at all" need no separate presentation.
 */
const EMPTY_SNAPSHOT = Object.freeze({
  status: 'unavailable',
  value: undefined,
  base: undefined,
  user: undefined,
  revision: undefined,
  writable: false,
  mode: 'memory',
})

/** Whether the missing-settings report has been made; one page, one report. */
let reportedMissingSettings = false

/**
 * Say, once, why this plugin is running without durable settings.
 *
 * Two callers, one message: `apply`, when the composition carries the service
 * that *replaced* the one this build binds (a mismatch it can see immediately),
 * and any write landing on the stand-in scope — the moment a user has to be told
 * that the switch they just flipped is not going to be saved.
 */
function reportMissingSettings() {
  if (reportedMissingSettings) return
  reportedMissingSettings = true
  console.error(
    `${PLUGIN_ID}: dsh is not providing the "${SETTINGS_SERVICE}" service, so the fixes run on their ` +
      `shipped defaults and the switches cannot be saved. dsh 0.1.7-alpha.1 replaced it with ` +
      `"${REPLACEMENT_SETTINGS_SERVICE}"; this build targets the dsh 0.1.5-rc.x line (latest/next). ` +
      'Pin dsh to 0.1.5-rc.x, or install a newer @citisen/dsh-ui-polish.',
  )
}

/**
 * The settings section this plugin never got.
 *
 * Reads answer "nothing resolved", so the fixes and the row run on their
 * defaults; every write reports the mismatch instead of failing silently. That is
 * the contract of a bound scope whose Host refuses a write, minus the wire call.
 * @returns an object shaped like a bound settings scope.
 */
function missingSettingsScope() {
  return {
    getSnapshot: () => EMPTY_SNAPSHOT,
    subscribe: () => () => undefined,
    set: () => {
      reportMissingSettings()
      return Promise.resolve(false)
    },
    unset: () => {
      reportMissingSettings()
      return Promise.resolve(false)
    },
    mutate: () => {
      reportMissingSettings()
      return Promise.resolve(false)
    },
  }
}

/**
 * The services this plugin waits for: slots and locale for the settings row.
 *
 * Settings are deliberately **not** in this list. A required service that a dsh
 * release stops providing holds the entire plugin in `pending` forever, which is
 * how 0.1.7-alpha.1 — where `settingsScope` was replaced by `configForms` —
 * turned a renamed service into plugins that never activated, reported only as
 * "waiting for service". The section is bound optionally in `apply` instead, so a
 * composition this build does not recognize still gets the fixes, the row, and a
 * message that names the reason.
 *
 * Nothing here reads the theme, so the plugin composes without it.
 */
export const inject = ['slots', 'locale']

/**
 * Client plugin body: install the enabled fixes, keep them in step with the
 * settings, and register the row that switches them.
 * @param ctx - client cordis context.
 */
export function apply(ctx) {
  installRowStyles(ctx)

  /** The bound `ui-polish` section, or a stand-in until (and unless) dsh provides one. */
  let scope = missingSettingsScope()

  /** The disposer of each fix currently installed, by fix id. */
  const installed = new Map()
  /** The row's store actions, until the row is injected. */
  let actions

  /**
   * Bring the installed set in line with a resolved section.
   *
   * A fix is installed, left alone, or disposed according to its own switch, so
   * flipping one switch cannot disturb another fix's listener — and a fix that is
   * already in the right state is not rebuilt, which keeps a settings write about
   * a *different* fix from dropping state in this one.
   * @param section - resolved settings section (ids to booleans).
   */
  const installEnabled = (section) => {
    for (const fix of FIXES) {
      const wanted = section[fix.id] !== false
      const current = installed.get(fix.id)
      if (wanted === (current !== undefined)) continue
      if (current !== undefined) {
        current()
        installed.delete(fix.id)
        continue
      }
      try {
        installed.set(fix.id, fix.install(ctx) ?? (() => {}))
      } catch (error) {
        // One fix failing must not take the others down, nor the activation.
        console.warn(`${PLUGIN_ID}: fix "${fix.id}" could not be installed`, error)
      }
    }
  }

  const paint = (section, revision) => {
    actions?.sync(section, revision)
    installEnabled(section)
  }

  /** Whether a settings answer has painted yet; see the two `adopt` callers. */
  let painted = false

  /** Paint what the live scope holds, or the shipped defaults when it holds nothing. */
  const adopt = () => {
    painted = true
    const snapshot = scope.getSnapshot()
    paint(snapshot.value ?? FIX_DEFAULTS, snapshot.revision)
  }

  ctx.effect(
    () => () => {
      for (const dispose of installed.values()) dispose()
      installed.clear()
    },
    'dsh-ui-polish: fix teardown',
  )

  // Bind the durable section when dsh provides the settings service, and follow it
  // while it stays: a replacement or an unload puts the fixes back on defaults.
  ctx.inject([SETTINGS_SERVICE], (settingsCtx) => {
    const bound = settingsCtx[SETTINGS_SERVICE].bind({
      namespace: POLISH_NAMESPACE,
      decode: (section) => {
        if (section === null || typeof section !== 'object') return undefined
        const raw = section
        return Object.fromEntries(FIXES.map((fix) => [fix.id, raw[fix.id] !== false]))
      },
    })
    scope = bound
    settingsCtx.effect(() => bound.subscribe(adopt), 'dsh-ui-polish: settings adoption')
    adopt()
    return () => {
      scope = missingSettingsScope()
      adopt()
    }
  })

  // Exactly one paint per settings answer: a bind that happened during activation
  // has painted already, and this covers the composition whose service never
  // arrives — the fixes still have to run, on their defaults.
  if (!painted) adopt()

  // A composition carrying the service that *replaced* this build's settings
  // service is a version mismatch that is visible already: report it now, since
  // without a row interaction no write would ever trigger the report.
  if (
    ctx.get(SETTINGS_SERVICE, false) === undefined &&
    ctx.get(REPLACEMENT_SETTINGS_SERVICE, false) !== undefined
  ) {
    reportMissingSettings()
  }

  const store = createRowStore()

  ctx.effect(
    () => ctx.locale.register(LOCALE_NAMESPACE, { zh, en }),
    'dsh-ui-polish: settings row dictionaries',
  )

  ctx.slots.inject('settings.general.item', () =>
    ctx.slots.register(
      {
        name: 'settings.general.item',
        id: 'ui-polish',
        order: 13,
        store,
        locale: LOCALE_NAMESPACE,
        inject: (bound) => {
          actions = bound
          const snapshot = scope.getSnapshot()
          paint(snapshot.value ?? FIX_DEFAULTS, snapshot.revision)
          return {
            setField: (field, value) => {
              scope.set(field, value)
            },
            reset: () => {
              for (const fix of FIXES) scope.unset(fix.id)
            },
          }
        },
      },
      UiPolishRow,
    ),
  )
}
