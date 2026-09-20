/**
 * Verify the host half without a running DSH: import `lib/index.js`, exercise the
 * schema against the real `@deepseek-ai/schemastery`, and drive `apply(ctx)` with
 * a stub context to prove the namespace registers.
 *
 * Usage:
 *   node scripts/verify-host.mjs
 *
 * Environment:
 *   DSH_HOME      Harness home holding profiles/ (default ~/.dsh)
 *   DSH_PROFILE   Profile name to resolve the plugin through (default web)
 */

import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const PACKAGE_NAME = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).name

/**
 * Import `lib/index.js`, either from a path given on the command line or from an
 * installed profile.
 *
 * The host half imports `@deepseek-ai/schemastery`, which dsh supplies to a
 * plugin from the installation's module fallback rather than from the plugin's
 * own tree. Importing through the profile link reproduces that resolution, so
 * this check also proves the plugin's runtime dependencies actually resolve where
 * dsh will load it from. Falling back to the direct path keeps the check usable
 * in a bare checkout.
 */
async function importHost() {
  const explicit = process.argv[2] ?? process.env.DSH_UI_POLISH_HOST
  if (explicit !== undefined) {
    return { host: await import(pathToFileURL(resolve(explicit)).href), via: resolve(explicit) }
  }
  const home = process.env.USERPROFILE ?? process.env.HOME ?? ''
  const dshHome = process.env.DSH_HOME ?? (home === '' ? undefined : join(home, '.dsh'))
  const profile = process.env.DSH_PROFILE ?? 'web'
  if (dshHome !== undefined) {
    const anchor = join(dshHome, 'profiles', profile, 'package.json')
    if (existsSync(anchor)) {
      try {
        // Resolve the bare specifier: `exports` maps "." to lib/index.js.
        const resolved = createRequire(anchor).resolve(PACKAGE_NAME)
        return { host: await import(pathToFileURL(resolved).href), via: resolved }
      } catch {
        /* not installed in that profile; fall through to the direct import */
      }
    }
  }
  const direct = join(root, 'lib', 'index.js')
  return { host: await import(pathToFileURL(direct).href), via: direct }
}

const { host, via } = await importHost()
console.log(`verify-host: loaded ${via}`)

const { POLISH_NAMESPACE, FIX_IDS, UiPolishSchema, apply } = host

assert.equal(POLISH_NAMESPACE, 'ui-polish')
assert.deepEqual(FIX_IDS, ['wheelThroughWidthHandle'])

// The schema resolves a complete default section — what an absent settings
// document must produce. Every fix defaults to on, because a fix exists to
// correct shipped behaviour rather than to be opted into.
const defaults = UiPolishSchema({})
for (const id of FIX_IDS) {
  assert.equal(defaults[id], true, `${id} must default to on`)
}

// A switch value is a boolean at the wire boundary; anything else is a bug in
// the row rather than a preference to store.
assert.equal(UiPolishSchema({ wheelThroughWidthHandle: false }).wheelThroughWidthHandle, false)
assert.throws(() => UiPolishSchema({ wheelThroughWidthHandle: 'off' }))
assert.throws(() => UiPolishSchema({ wheelThroughWidthHandle: 1 }))

// Drive apply(ctx) with a stub that records the namespace registration.
const registered = []
let injectedSettings
const ctx = {
  inject(deps, callback) {
    assert.deepEqual(deps, ['settings'])
    injectedSettings = {
      settings: {
        register(namespace, schema) {
          registered.push({ namespace, schema })
        },
      },
    }
    callback(injectedSettings)
  },
  get(name) {
    return name === 'settings' ? injectedSettings.settings : undefined
  },
}

apply(ctx)

assert.equal(registered.length, 1)
assert.equal(registered[0].namespace, 'ui-polish')
assert.ok(registered[0].schema !== undefined)

// With no provider at all, apply() must still be a no-op rather than throwing:
// the browser half falls back to the same defaults.
apply({ inject: () => undefined, get: () => undefined })

console.log('verify-host: OK — namespace registered, defaults and rejects verified')
