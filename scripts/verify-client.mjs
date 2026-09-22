/**
 * Load an emitted DSH client bundle in Node, assert its envelope, then run its
 * fixes against DOM stubs and its settings row against stub services.
 *
 * A broken client bundle otherwise fails only in the browser, where the
 * diagnostic is a console error inside the boot audit. This check makes the
 * cheap-to-catch failure modes — a bundle that registers nothing, a factory that
 * throws, a wheel bridge that swallows the event it did not take over, a switch
 * that no longer installs or disposes its fix — fail on the command line.
 *
 * Usage:
 *   node scripts/verify-client.mjs [path/to/lib/client.js]
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const bundlePath = resolve(process.argv[2] ?? join(root, 'lib', 'client.js'))
const source = readFileSync(bundlePath, 'utf8')

/** The package name, which the bundle id must equal. */
const PACKAGE_NAME = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).name

/**
 * Minimal React stub: enough to build a tree, plus enough hook state to drive
 * interactions. Only one component instance may hold live hook state at a time,
 * because the slots are keyed by `useState` call order, so `mount()` hands out
 * one instance at a time.
 * @returns `{ render }`.
 */
function mount() {
  let slots
  const render = (component, props) => {
    if (slots === undefined) slots = []
    react.__hookIndex = 0
    react.__slots = slots
    return component(props)
  }
  return { render }
}

const react = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  useCallback: (fn) => fn,
  useEffect: () => undefined,
  useRef: (value) => ({ current: value }),
  useState: (value) => {
    const slots = react.__slots ?? (react.__slots = [])
    const index = react.__hookIndex ?? 0
    if (slots.length <= index) slots.push(value)
    react.__hookIndex = index + 1
    return [
      slots[index],
      (next) => {
        slots[index] = typeof next === 'function' ? next(slots[index]) : next
      },
    ]
  },
}

/** A tiny observable store, matching the `@deepseek-ai/dsh-client-store` face. */
const stores = []
const storeModule = {
  defineStore: (spec) => {
    const state = spec.init()
    const listeners = new Set()
    const handle = {
      spec,
      state,
      create: () =>
        Object.fromEntries(
          Object.entries(spec.actions).map(([name, action]) => [
            name,
            (...args) => {
              action(state, ...args)
              for (const listener of listeners) listener()
            },
          ]),
        ),
      getSnapshot: () => state,
      subscribe: (listener) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
    }
    stores.push(handle)
    return handle
  },
}

const stubs = {
  react,
  'react/jsx-runtime': { jsx: react.createElement, jsxs: react.createElement },
  'react-dom': {},
  'react-dom/client': {},
  '@deepseek-ai/cordis': {},
  '@deepseek-ai/dsh-client-store': storeModule,
  '@deepseek-ai/dsh-client-ui-slots': {},
  '@deepseek-ai/dsh-client-ui-primitives': new Proxy(
    {},
    { get: (_target, key) => (key === 'then' ? undefined : () => null) },
  ),
  '@deepseek-ai/dsh-client-ui-dockkit': {},
}

const registrations = []
globalThis.window = {
  __ModuleLoader__: {
    load(registration) {
      registrations.push(registration)
    },
  },
}
globalThis.console = console

const requested = []
const requireStub = (specifier) => {
  requested.push(specifier)
  if (!(specifier in stubs)) throw new Error(`unknown platform module "${specifier}"`)
  return stubs[specifier]
}

// eslint-disable-next-line no-eval -- the bundle is a classic script by contract
;(0, eval)(source)

assert.equal(registrations.length, 1, 'the bundle must register exactly one factory')
const [registration] = registrations
assert.equal(registration.id, PACKAGE_NAME)
assert.equal(typeof registration.factory, 'function')

const plugin = registration.factory(requireStub)
assert.equal(typeof plugin.apply, 'function', 'bundle must export apply()')
assert.ok(Array.isArray(plugin.inject), 'bundle must export inject as an array')
// Settings are bound optionally, not required. A dsh that stops providing the
// service — 0.1.7-alpha.1 replaced `settingsScope` with `configForms` — must
// leave this plugin activated on its defaults instead of `pending` forever,
// which is what a required entry in this list buys. The last block of this file
// runs that composition.
assert.deepEqual(plugin.inject, ['slots', 'locale'])
assert.ok(Array.isArray(plugin.FIXES), 'bundle must export the fix registry')

// The build must have substituted the template's identity placeholder, or the
// plugin would stamp its stylesheet and its warnings with the placeholder.
assert.ok(
  !source.includes('dsh:plugin-id'),
  'the identity placeholder must be substituted at build time',
)

// ── the fix registry, and the half that has to agree with it ────────────────
// The two halves are separate bundles and cannot share a module, so the fix ids
// are duplicated by hand. Comparing them here is what turns a silent drift —
// a switch that toggles a key no fix reads — into a failing check.
{
  const ids = plugin.FIXES.map((fix) => fix.id)
  assert.deepEqual(ids, ['wheelThroughWidthHandle'])
  for (const fix of plugin.FIXES) {
    assert.equal(typeof fix.install, 'function', `${fix.id} must be installable`)
    assert.equal(typeof fix.labelKey, 'string')
    assert.equal(typeof fix.hintKey, 'string')
  }
  assert.deepEqual(plugin.FIX_DEFAULTS, { wheelThroughWidthHandle: true })

  const hostSource = readFileSync(join(root, 'lib', 'index.js'), 'utf8')
  const declared = /const FIX_IDS = \[([^\]]*)\]/.exec(hostSource)?.[1]
  assert.ok(declared !== undefined, 'the host half must declare FIX_IDS')
  const hostIds = [...declared.matchAll(/'([^']+)'/g)].map((match) => match[1])
  assert.deepEqual(ids, hostIds, 'both halves must list the same fixes')
}

// ── the strip selector ──────────────────────────────────────────────────────
// A fake element that answers `closest` the way the browser would for a node
// whose own attributes match.
function fakeHandle(attributes) {
  return {
    nodeType: 1,
    attributes,
    contains: () => false,
    closest(selector) {
      const wanted = selector.split(',')
      for (const candidate of wanted) {
        if (candidate === '[data-width-handle]' && 'data-width-handle' in this.attributes) return this
        if (
          candidate.startsWith('[class*=') &&
          String(this.attributes.class ?? '').includes('widthHandle')
        ) {
          return this
        }
      }
      return null
    },
  }
}

{
  const strip = fakeHandle({ 'data-width-handle': 'left' })
  assert.equal(plugin.handleFromTarget(strip), strip, 'the strip itself must match')
  const inside = { nodeType: 1, closest: () => strip }
  assert.equal(plugin.handleFromTarget(inside), strip, 'a node inside the strip must match')
  assert.equal(plugin.handleFromTarget(fakeHandle({ class: 'wSkVaW_widthHandle' })).attributes['data-width-handle'], undefined)
  assert.ok(
    plugin.handleFromTarget(fakeHandle({ class: 'x_widthHandle' })) !== undefined,
    'the CSS-module class is the fallback hook',
  )
  // The frame's own column handles are deliberately NOT matched: they are 8px,
  // visible, and not reported as swallowing the wheel.
  assert.equal(plugin.handleFromTarget(fakeHandle({ class: 'pI_x6G_handle' })), undefined)
  assert.equal(plugin.handleFromTarget(null), undefined)
  assert.equal(plugin.handleFromTarget({}), undefined)
}

// ── the scroll arithmetic ───────────────────────────────────────────────────
assert.equal(plugin.wheelPixels(120, 0, () => assert.fail('pixels must not measure anything')), 120)
assert.equal(plugin.wheelPixels(3, 1, () => ({ lineHeight: 20 })), 60)
assert.equal(plugin.wheelPixels(3, 1, () => ({ lineHeight: Number.NaN })), 48, 'a line delta needs a fallback')
assert.equal(plugin.wheelPixels(1, 2, () => ({ pageHeight: 400 })), 400)
assert.equal(plugin.wheelPixels(0, 0, () => ({})), 0)
assert.equal(plugin.wheelPixels(Number.NaN, 0, () => ({})), 0)

{
  const scroller = { scrollTop: 100, scrollHeight: 1000, clientHeight: 400 }
  assert.equal(plugin.canScroll(scroller, 10), true)
  assert.equal(plugin.canScroll(scroller, -10), true)
  assert.equal(plugin.canScroll({ ...scroller, scrollTop: 0 }, -10), false, 'no room upwards')
  assert.equal(plugin.canScroll({ ...scroller, scrollTop: 600 }, 10), false, 'no room downwards')
  assert.equal(plugin.canScroll({ ...scroller, scrollTop: 599.6 }, 10), false, 'a fractional end is still the end')
  assert.equal(plugin.canScroll({ ...scroller, scrollHeight: 400 }, 10), false, 'nothing to scroll')
  assert.equal(plugin.canScroll(scroller, 0), false)
}

// ── the decision: when the bridge takes the wheel, and where it sends it ────
/** A scroll container stub, with the metrics the bridge reads lazily. */
function scrollerStub(scrollTop, scrollHeight, clientHeight, lineHeight = 20) {
  return {
    nodeType: 1,
    parentElement: null,
    scrollTop,
    scrollHeight,
    clientHeight,
    lineHeight,
  }
}

/** The DOM bag `wheelPlan` takes, with the reads it needs. */
function planDom({ strip, under, ancestors = new Map(), metrics }) {
  return {
    handleFrom: (target) => (target === 'strip' ? strip : undefined),
    elementsAt: () => under,
    scrollerFrom: (element) =>
      typeof element === 'object' && element !== null && 'scrollHeight' in element
        ? element
        : ancestors.get(element),
    metricsFor: metrics ?? ((scroller) => ({ lineHeight: scroller.lineHeight, pageHeight: scroller.clientHeight })),
  }
}

const strip = { contains: (node) => node === 'inside-strip' }
const event = { target: 'strip', clientX: 40, clientY: 300, deltaY: 120, deltaMode: 0, ctrlKey: false }

{
  const scroller = scrollerStub(100, 1000, 400)
  const plan = plugin.wheelPlan(event, planDom({ strip, under: [strip, 'inside-strip', scroller] }))
  assert.deepEqual(plan, { scroller, pixels: 120 }, 'the wheel is handed to the scroller under the strip')
}

// Not our strip: the event must be left completely alone, or the plugin would
// break scrolling everywhere else in the interface.
assert.equal(
  plugin.wheelPlan({ ...event, target: 'elsewhere' }, planDom({ strip, under: ['scroller'] })),
  undefined,
)
// Ctrl+wheel is the browser's zoom.
assert.equal(plugin.wheelPlan({ ...event, ctrlKey: true }, planDom({ strip, under: [scrollerStub(0, 1000, 400)] })), undefined)
// A horizontal-only wheel over the strip has nothing to forward vertically.
assert.equal(plugin.wheelPlan({ ...event, deltaY: 0 }, planDom({ strip, under: [scrollerStub(0, 1000, 400)] })), undefined)
// At the end of the transcript the event is left for the browser to chain, so
// the strip cannot become a different dead zone.
assert.equal(
  plugin.wheelPlan({ ...event, deltaY: 120 }, planDom({ strip, under: [scrollerStub(600, 1000, 400)] })),
  undefined,
)
assert.equal(
  plugin.wheelPlan({ ...event, deltaY: -120 }, planDom({ strip, under: [scrollerStub(0, 1000, 400)] })),
  undefined,
)
// The strip and anything inside it are skipped: the search starts at what the
// strip is covering, not at the strip.
{
  const scroller = scrollerStub(100, 1000, 400)
  const plan = plugin.wheelPlan(event, planDom({ strip, under: [strip, 'inside-strip', 'plain', scroller] }))
  assert.deepEqual(plan, { scroller, pixels: 120 }, 'a non-scrolling node under the strip is walked past')
}
// Line and page deltas are converted, and only then.
{
  const scroller = scrollerStub(100, 1000, 400, 24)
  const lines = plugin.wheelPlan({ ...event, deltaY: 3, deltaMode: 1 }, planDom({ strip, under: [scroller] }))
  assert.deepEqual(lines, { scroller, pixels: 72 })
  const pages = plugin.wheelPlan({ ...event, deltaY: 1, deltaMode: 2 }, planDom({ strip, under: [scroller] }))
  assert.deepEqual(pages, { scroller, pixels: 400 })
}

// ── the bridge as the browser drives it ─────────────────────────────────────
/** Install a document stub that records listeners and answers the DOM reads. */
function installDocumentStub({ under, overflowY = 'auto' }) {
  const added = []
  const removed = []
  const document = {
    addEventListener: (type, listener, options) => added.push({ type, listener, options }),
    removeEventListener: (type, listener, options) => removed.push({ type, listener, options }),
    elementsFromPoint: () => under,
    createElement: () => ({ dataset: {}, textContent: '', remove: () => undefined }),
    head: { appendChild: () => undefined },
    querySelector: () => null,
  }
  globalThis.document = document
  globalThis.getComputedStyle = () => ({ overflowY })
  return { added, removed }
}

{
  const scroller = scrollerStub(100, 1000, 400)
  const { added, removed } = installDocumentStub({ under: [scroller] })
  const dispose = plugin.installWheelThrough()

  assert.equal(added.length, 1)
  assert.equal(added[0].type, 'wheel')
  assert.deepEqual(added[0].options, { capture: true, passive: false })

  const { listener } = added[0]
  // Drive the listener with an event shaped like the browser's.
  let prevented = 0
  const wheel = {
    target: fakeHandle({ 'data-width-handle': 'right' }),
    clientX: 40,
    clientY: 300,
    deltaY: 120,
    deltaMode: 0,
    ctrlKey: false,
    preventDefault: () => {
      prevented += 1
    },
  }
  listener(wheel)
  assert.equal(prevented, 1, 'the event the bridge takes over must be cancelled')
  assert.equal(scroller.scrollTop, 220, 'and the scroll must actually happen')

  // An event over the transcript itself is not ours: no cancel, no scroll.
  prevented = 0
  listener({ ...wheel, target: { closest: () => null } })
  assert.equal(prevented, 0, 'the bridge must not touch the events it does not own')
  assert.equal(scroller.scrollTop, 220)

  dispose()
  assert.equal(removed.length, 1)
  assert.deepEqual(removed[0].options, { capture: true })
  assert.equal(removed[0].listener, listener)
}

// ── the settings row ────────────────────────────────────────────────────────
/** Collect every element in a tree, depth-first, flattening array children. */
function collectElements(node, out = []) {
  if (node === null || node === undefined) return out
  if (Array.isArray(node)) {
    for (const entry of node) collectElements(entry, out)
    return out
  }
  if (typeof node !== 'object') return out
  out.push(node)
  const children = Array.isArray(node.children) ? node.children : [node.children]
  for (const child of children) collectElements(child, out)
  collectElements(node.props?.children, out)
  return out
}

/**
 * Every switch the row renders.
 *
 * The React stub does not render function components, so a `FixSwitch` stays an
 * unresolved element in the row's tree; rendering it at its own level with the
 * props the row passed down is exactly what a real browser does, and it keeps
 * the assertion on the component that owns the switch.
 * @param tree - the row's rendered tree.
 * @returns the switch buttons, in order.
 */
function switchButtons(tree) {
  return collectElements(tree)
    .filter((element) => typeof element.type === 'function' && element.type.name === 'FixSwitch')
    .flatMap((element) => collectElements(element.type(element.props)))
    .filter((element) => element.props?.role === 'switch')
}

{
  const writes = []
  let resets = 0
  const tree = plugin.UiPolishRow({
    t: (key) => key,
    useStore: (selector) => selector({ wheelThroughWidthHandle: true }),
    setField: (field, value) => writes.push([field, value]),
    reset: () => {
      resets += 1
    },
  })

  const switches = switchButtons(tree)
  assert.equal(switches.length, plugin.FIXES.length, 'one switch per fix')
  assert.equal(switches[0].props['aria-checked'], true)
  assert.equal(switches[0].props['aria-label'], 'uiPolish.fix.wheel')

  switches[0].props.onClick()
  assert.deepEqual(writes, [['wheelThroughWidthHandle', false]], 'the switch writes the fix id')

  const reset = collectElements(tree).find(
    (element) => element.type === 'button' && element.props.className === 'dsh-polish-reset',
  )
  assert.ok(reset !== undefined, 'the row must offer a reset')
  reset.props.onClick()
  assert.equal(resets, 1)
}

{
  const off = plugin.UiPolishRow({
    t: (key) => key,
    useStore: (selector) => selector({ wheelThroughWidthHandle: false }),
    setField: () => undefined,
    reset: () => undefined,
  })
  assert.equal(switchButtons(off)[0].props['aria-checked'], false)
}

// ── apply(ctx) end to end ───────────────────────────────────────────────────
const dictionaries = []
const registeredSlots = []
const locale = {
  register: (namespace, dict) => {
    dictionaries.push({ namespace, dict })
    return () => undefined
  },
}

/** A mutable settings section, so a toggle can flow through the whole plugin. */
let section = {}
let scopeListener
const scope = {
  getSnapshot: () => ({ status: 'ready', value: section, revision: scopeRevision, writable: true }),
  subscribe: (listener) => {
    scopeListener = listener
    return () => undefined
  },
  set: (field, value) => {
    section = { ...section, [field]: value }
    scopeRevision += 1
    scopeListener()
  },
  unset: (field) => {
    const { [field]: _removed, ...kept } = section
    section = kept
    scopeRevision += 1
    scopeListener()
  },
}
let scopeRevision = 1

const settingsScopeService = { bind: (spec) => (assert.equal(spec.namespace, 'ui-polish'), scope) }

const ctx = {
  effect: (execute) => {
    const disposer = execute()
    return { dispose: typeof disposer === 'function' ? disposer : () => undefined }
  },
  on: () => undefined,
  get: (name) => (name === 'settingsScope' ? settingsScopeService : undefined),
  // The optional bind under test: the service is present here, so the callback
  // runs as it does in the browser. `settingsScope` stays on the fixture context
  // as well, because that is the context a bound scope is read from.
  inject: (deps, callback) => {
    assert.deepEqual(deps, ['settingsScope'])
    callback(ctx)
    return { dispose: () => undefined }
  },
  locale,
  settingsScope: settingsScopeService,
  slots: {
    inject: (name, callback) => {
      assert.equal(name, 'settings.general.item')
      callback()
    },
    register: (options, component) => {
      registeredSlots.push({ options, component })
      return () => undefined
    },
  },
}

{
  const scroller = scrollerStub(100, 1000, 400)
  const { added, removed } = installDocumentStub({ under: [scroller] })

  plugin.apply(ctx)

  assert.equal(added.length, 1, 'an enabled fix installs itself at activation')

  assert.equal(dictionaries.length, 1)
  assert.equal(dictionaries[0].namespace, 'settings.uiPolish')
  assert.deepEqual(
    Object.keys(dictionaries[0].dict.zh).sort(),
    Object.keys(dictionaries[0].dict.en).sort(),
    'both dictionaries must cover the same keys',
  )

  assert.equal(registeredSlots.length, 1)
  const [{ options, component }] = registeredSlots
  assert.equal(options.id, 'ui-polish')
  assert.equal(options.name, 'settings.general.item')
  assert.equal(options.locale, 'settings.uiPolish')
  assert.ok(stores.length >= 1, 'the row must register a store')

  const actions = options.inject(options.store.create())
  assert.equal(typeof actions.setField, 'function')
  assert.equal(typeof actions.reset, 'function')
  // Mounting the row re-reads the same settings, which must not rebuild a fix
  // that is already in the right state.
  assert.equal(added.length, 1, 'mounting the row must not rebuild an installed fix')
  assert.equal(removed.length, 0)

  // The row renders from the store, which the inject face just synced.
  const tree = component({
    t: (key) => key,
    useStore: (selector) => selector(options.store.getSnapshot()),
    ...actions,
  })
  const switches = switchButtons(tree)
  assert.equal(switches[0].props['aria-checked'], true, 'an absent setting means on')

  // Turning it off must dispose the listener, not merely stop scrolling.
  actions.setField('wheelThroughWidthHandle', false)
  assert.equal(removed.length, 1, 'the switch must dispose the installed fix')
  assert.equal(removed[0].listener, added[0].listener)

  // And turning it back on must install a fresh one.
  actions.setField('wheelThroughWidthHandle', true)
  assert.equal(added.length, 2, 'turning it back on reinstalls the fix')

  // Reset clears the stored switch, and the default brings the fix back.
  actions.setField('wheelThroughWidthHandle', false)
  assert.equal(removed.length, 2)
  actions.reset()
  assert.deepEqual(section, {}, 'reset clears the stored switches')
  assert.equal(added.length, 3, 'the fix returns on the default')
}

// ── a composition that provides no `settingsScope` ──────────────────────────
//
// dsh 0.1.7-alpha.1 replaced the Web client's settings service with
// `configForms`. A build that required the old name never activated there at
// all: the boot audit listed this plugin as an entry that "did not activate",
// waiting for a service that release does not have. The service is optional now,
// and this is the composition that must still run the fixes and fill the row,
// with one honest report — at activation, when the replacement service makes the
// mismatch visible, and never twice.
{
  const incompatibleSlots = []
  const incompatibleDictionaries = []
  const reported = []
  const replacementOnlyCtx = {
    effect: (execute) => {
      const disposer = execute()
      return { dispose: typeof disposer === 'function' ? disposer : () => undefined }
    },
    on: () => undefined,
    // Only the REPLACEMENT service exists, which is what makes the mismatch
    // visible without waiting for anything.
    get: (name) => (name === 'configForms' ? {} : undefined),
    inject: (deps) => {
      assert.deepEqual(deps, ['settingsScope'])
      // And it never arrives: this composition started without it.
      return { dispose: () => undefined }
    },
    locale: {
      register: (namespace, dict) => {
        incompatibleDictionaries.push({ namespace, dict })
        return () => undefined
      },
    },
    slots: {
      inject: (name, callback) => {
        assert.equal(name, 'settings.general.item')
        callback()
      },
      register: (options, component) => {
        incompatibleSlots.push({ options, component })
        return () => undefined
      },
    },
  }

  const { added } = installDocumentStub({ under: [] })
  const realError = console.error
  console.error = (...args) => reported.push(args.join(' '))
  try {
    plugin.apply(replacementOnlyCtx)
    assert.equal(reported.length, 1, 'a visible mismatch is reported at activation')
    assert.equal(added.length, 1, 'the shipped defaults must still install the fix')
    // The writes the row offers must not throw on a scope that never resolves,
    // and must not repeat a report the page already carries.
    const actions = incompatibleSlots[0].options.inject(incompatibleSlots[0].options.store.create())
    actions.setField('wheelThroughWidthHandle', false)
    actions.reset()
  } finally {
    console.error = realError
  }

  assert.equal(incompatibleSlots.length, 1, 'the row must register without a settings service')
  assert.equal(incompatibleDictionaries.length, 1, 'the row copy must register too')
  assert.equal(added.length, 1, 'a switch that cannot be saved must not disrupt the fix')
  assert.equal(reported.length, 1, 'the mismatch is reported once, not once per write')
  assert.match(reported[0], /settingsScope/)
  assert.match(reported[0], /configForms/)
  assert.match(reported[0], /0\.1\.5-rc\.x/)
  assert.match(reported[0], /@citisen\/dsh-ui-polish/)
}

delete globalThis.document
delete globalThis.getComputedStyle
delete globalThis.window

console.log('verify-client: OK — envelope, fix registry, wheel bridge, and settings row verified')
console.log(`verify-client: factory required ${requested.join(', ')}`)
