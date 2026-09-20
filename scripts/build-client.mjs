/**
 * Build `lib/client.js` from `src/client.js`.
 *
 * DSH client bundles are classic scripts, not ES modules: the browser shell
 * loads them with a plain `<script>` element and they may only register a lazy
 * CJS factory with `window.__ModuleLoader__`. This script applies that envelope
 * and rewrites the template's static ESM imports into the factory's CommonJS
 * `require` form.
 *
 * The transformation is deliberately narrow — it supports exactly the import
 * shapes the template uses — because a hand-rolled client bundle has no bundler
 * to catch a mistake. Any unsupported syntax fails the build loudly.
 *
 * Usage:
 *   node scripts/build-client.mjs           # write lib/client.js
 *   node scripts/build-client.mjs --watch   # rebuild on save (for dsh-client-hmr)
 *   node scripts/build-client.mjs --check   # fail if lib/client.js is stale
 */

import { readFileSync, watch, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const sourcePath = join(root, 'src', 'client.js')
const outputPath = join(root, 'lib', 'client.js')

/**
 * The bundle id the shell's module table keys on. It must equal the package
 * name: `dsh-client-modules` resolves a roster row by the loader entry name and
 * matches it against the id the bundle registers. Read from package.json rather
 * than duplicated here, so a rename cannot desynchronize the two.
 */
const PACKAGE_NAME = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).name

/**
 * The names the envelope exports from the compiled factory. The first two are
 * what the loader consumes; the rest exist so the verifier can unit-test the
 * pure builders and the row component without re-parsing the source.
 */
const ENVELOPE_EXPORTS = [
  'apply',
  'inject',
  'FIXES',
  'FIX_DEFAULTS',
  'HANDLE_SELECTOR',
  'handleFromTarget',
  'nearestScroller',
  'wheelPixels',
  'canScroll',
  'wheelPlan',
  'installWheelThrough',
  'createRowStore',
  'UiPolishRow',
]

/**
 * `import [default][, { named }] from 'spec'`, with no nested braces.
 * Matches the whole line so no stray `import` survives the rewrite.
 *
 * The default name's comma is optional so that a lone default import
 * (`import React from 'react'`) is rewritten too: the form with named bindings
 * is not the only one a template may use, and a line the pattern misses is left
 * in the bundle as an ES import inside a classic script — which parses nowhere
 * and fails only in the browser.
 */
const IMPORT_PATTERN =
  /^import\s+(?:(?<default>[A-Za-z_$][\w$]*)(?:\s*,\s*)?)?(?:\{\s*(?<named>[^{}]*?)\s*\})?\s*from\s*'(?<spec>[^']+)'\s*$/gm

/**
 * The only specifiers the shell seeds into the browser module table. Anything
 * else has to be declared in `dsh.client.external` and shipped as its own
 * graph row; a mistake would otherwise surface only at runtime in the browser.
 */
const PLATFORM_SINGLETONS = new Set([
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
])

/**
 * Turn one specifier into the alias the compiled bundle binds it to, matching
 * the naming convention DSH's own bundles are emitted with.
 * @param spec - module specifier, e.g. `react/jsx-runtime`.
 * @returns the bound identifier.
 */
function aliasFor(spec) {
  return `_${spec.replace(/^@/, '').replace(/[^A-Za-z0-9]+/g, '_').replace(/_+$/, '')}`
}

/**
 * Rewrite every static import into a `let <alias> = require('<spec>')`
 * binding, exactly as the shipped bundles are emitted.
 * @param source - the template source.
 * @returns the transformed source and the specifiers it requests.
 */
function rewriteImports(source) {
  const requested = []
  const namedBindings = []
  const defaultBindings = []
  let matched = 0

  const body = source.replace(IMPORT_PATTERN, (...args) => {
    const groups = args.at(-1)
    const { default: defaultName, named, spec } = groups
    matched += 1
    requested.push(spec)

    const generated = aliasFor(spec)
    // A default import binds the alias itself (`let _react = require("react")`
    // is the whole module object); a named one reaches through a property read.
    // Both are resolved to the alias so the emitted body never mentions the
    // original local name.
    if (defaultName !== undefined) {
      if (!/^[A-Za-z_$][\w$]*$/.test(defaultName)) {
        throw new Error(`build-client: unsupported default import name "${defaultName}"`)
      }
      defaultBindings.push([spec, defaultName])
    }
    for (const entry of (named ?? '').split(',')) {
      const trimmed = entry.trim()
      if (trimmed === '') continue
      if (!/^[A-Za-z_$][\w$]*$/.test(trimmed)) {
        throw new Error(
          `build-client: unsupported named import "${trimmed}" from "${spec}" — write the local name identical to the exported name`,
        )
      }
      namedBindings.push([spec, trimmed])
    }
    return `\t\tlet ${generated} = require(${JSON.stringify(spec)});`
  })

  if (matched === 0) throw new Error('build-client: no static imports found in src/client.js')
  // A leftover import means the pattern missed a form it did not anticipate.
  // Emitting it would produce a bundle that cannot parse, which the browser
  // reports as the plugin simply never loading.
  const leftover = /^\s*import[\s{*]/m.exec(body)
  if (leftover !== null) {
    throw new Error(
      `build-client: an import the transformation cannot express survived rewriting (at "${leftover[0].trim()}"); use a static import of a platform singleton`,
    )
  }
  return { body, requested, namedBindings, defaultBindings }
}

/**
 * Resolve every imported identifier to its `require` alias, matching how DSH's
 * own bundles consume the module table. The replacement is anchored so it can
 * never touch an already-qualified access, a string, or a property name.
 * @param body - source whose imports have been rewritten.
 * @param bindings - the `rewriteImports` binding lists.
 * @returns the rewritten source.
 */
function qualifyImports(body, { namedBindings, defaultBindings }) {
  let out = body
  const seen = new Set()
  const replaceIdentifier = (name, replacement) => {
    if (seen.has(name)) return
    seen.add(name)
    const pattern = new RegExp(`(?<![.\\w$'"\`])${name}(?=[\\s(.,;)\\]}])`, 'g')
    out = out.replace(pattern, replacement)
  }
  for (const [spec, name] of defaultBindings) replaceIdentifier(name, aliasFor(spec))
  for (const [spec, name] of namedBindings) replaceIdentifier(name, `${aliasFor(spec)}.${name}`)
  return out
}

/**
 * The plugin-identity declaration the template carries. The build substitutes
 * the real package name, which is the value the stylesheet tag and the plugin's
 * diagnostics are stamped with. Keeping it single-sourced in package.json means
 * a rename cannot desynchronize the bundle id and what the plugin calls itself.
 */
const IDENTITY_PATTERN = /\/\* dsh:plugin-id \*\/\s*(['"])[^'"]*\1/

/**
 * Substitute the template's identity declaration with the real package name.
 * @param body - source after import rewriting.
 * @returns the source with the single declaration substituted.
 * @throws {Error} when the declaration is missing or repeated.
 */
function substituteIdentity(body) {
  const matches = body.match(new RegExp(IDENTITY_PATTERN.source, 'g')) ?? []
  if (matches.length !== 1) {
    throw new Error(
      `build-client: src/client.js must contain exactly one /* dsh:plugin-id */ identity declaration (found ${String(matches.length)})`,
    )
  }
  return body.replace(IDENTITY_PATTERN, JSON.stringify(PACKAGE_NAME))
}

/**
 * Strip the template's `export` keywords. The envelope re-exports
 * {@link ENVELOPE_EXPORTS} from the factory, so each of those only has to be a
 * top-level declaration — exporting it is optional and is removed either way.
 * @param body - transformed template source.
 * @returns source without declaration exports.
 */
function stripExports(body) {
  for (const name of ENVELOPE_EXPORTS) {
    const declaration = new RegExp(
      `^(?:export )?(?:const|let|var|function|class) ${name}\\b`,
      'm',
    )
    if (!declaration.test(body)) {
      throw new Error(
        `build-client: src/client.js must declare \`${name}\` at the top level for the envelope to re-export`,
      )
    }
  }
  const stripped = body.replace(/^export (const|let|var|function|class) /gm, '$1 ')
  if (/^\s*export\s/m.test(stripped)) {
    throw new Error(
      'build-client: src/client.js contains an export form the build cannot strip (only top-level declarations may be exported)',
    )
  }
  return stripped
}

/**
 * Wrap the transformed source in the DSH client-bundle envelope.
 * @param body - transformed, export-stripped template source.
 * @returns the complete bundle text.
 */
function wrap(body) {
  const exports = ENVELOPE_EXPORTS.map((name) => `\t\texports.${name} = ${name};`).join('\n')
  return `window.__ModuleLoader__.load({
\tid: ${JSON.stringify(PACKAGE_NAME)},
\tfactory: (require) => {
\t\tvar module = { exports: {} };
\t\tvar exports = module.exports;
\t\tObject.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
${body.trimEnd()}
${exports}
\t\treturn module.exports;
\t}
});
`
}

/**
 * Compile the template into the complete bundle text.
 * @returns the bundle and the specifiers it requests.
 * @throws {Error} on any import shape the transformation cannot express.
 */
function compile() {
  const template = readFileSync(sourcePath, 'utf8')
  const { body, requested, namedBindings, defaultBindings } = rewriteImports(template)

  for (const spec of requested) {
    if (!PLATFORM_SINGLETONS.has(spec)) {
      throw new Error(
        `build-client: src/client.js imports "${spec}", which is not a platform singleton; declare it in dsh.client.external and ship it as its own client bundle`,
      )
    }
  }

  return {
    bundle: wrap(
      substituteIdentity(qualifyImports(stripExports(body), { namedBindings, defaultBindings })),
    ),
    requested,
  }
}

/** Compile and write, reporting what changed. @returns whether the file changed. */
function build() {
  const { bundle, requested } = compile()
  let existing
  try {
    existing = readFileSync(outputPath, 'utf8')
  } catch {
    existing = undefined
  }
  if (existing === bundle) {
    console.log('build-client: lib/client.js already up to date')
    return false
  }
  writeFileSync(outputPath, bundle, 'utf8')
  console.log(
    `build-client: wrote lib/client.js (${String(bundle.length)} bytes, requires ${requested.join(', ')})`,
  )
  return true
}

if (process.argv.includes('--check')) {
  let existing
  try {
    existing = readFileSync(outputPath, 'utf8')
  } catch {
    console.error('build-client: lib/client.js is missing; run `node scripts/build-client.mjs`')
    process.exit(1)
  }
  if (existing !== compile().bundle) {
    console.error('build-client: lib/client.js is stale; run `node scripts/build-client.mjs`')
    process.exit(1)
  }
  console.log('build-client: lib/client.js is up to date')
} else if (process.argv.includes('--watch')) {
  build()
  console.log('build-client: watching src/client.js (Ctrl-C to stop)')
  let timer
  watch(sourcePath, () => {
    clearTimeout(timer)
    timer = setTimeout(() => {
      try {
        build()
      } catch (error) {
        // Keep watching: a syntax error mid-edit must not kill the watcher.
        console.error(String(error instanceof Error ? error.message : error))
      }
    }, 50)
  })
} else {
  build()
}
