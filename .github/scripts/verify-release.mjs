#!/usr/bin/env node
/**
 * Release gate — runs in the BUILD job of .github/workflows/stage.yml.
 *
 * That job deliberately has NO `id-token: write`, and check 5 asserts it. If
 * this script could mint an OIDC token, then `npm ci`, the repository's own
 * check scripts and the packer would all be running next to a signing key —
 * which is exactly the shape of the TanStack / "Mini Shai-Hulud" compromise
 * (May 2026): the attacker never stole a token, they got code execution inside
 * the job that could mint one. The job that signs is a separate, minimal job
 * that runs no repository code at all.
 *
 * Checks:
 *   1. HEAD carries the tag v<version> (skipped for non-latest dist-tags)
 *   2. no publish/install-time lifecycle script beyond the one known-safe form
 *   3. publishConfig: official registry, public, no pinned dist-tag
 *   4. every dependency is a registry version range (no git:/file:/https:)
 *   5. no .npmrc, no npm token in the environment, and no OIDC available here
 *   6. `npm pack --ignore-scripts`, then: content allowlist derived from
 *      package.json `files`, every packed path must be a git-tracked file (or
 *      a declared build output), size cap, exports targets really exist
 *   7. prints the tarball inventory and its sha512 as release evidence
 *
 * The evidence is the point of 6+7: the staging job re-hashes the same bytes
 * and refuses to stage anything else, and the integrity printed here is what
 * the maintainer compares against npm before approving the stage.
 */

import { createHash } from 'node:crypto'
import { execFileSync, execSync } from 'node:child_process'
import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

/**
 * Path prefixes that are build output rather than committed source, declared by
 * the workflow as ALLOW_UNTRACKED (comma separated). They are allowed to be
 * absent from `git ls-files`; everything else in the tarball must be tracked,
 * so a step that fabricates a file before packing is caught. A DSH plugin
 * commits its `lib/` and declares nothing here; litearea builds `dist/`.
 */
const ALLOW_UNTRACKED = (process.env.ALLOW_UNTRACKED ?? '')
  .split(',')
  .map((prefix) => prefix.trim())
  .filter(Boolean)

const REGISTRY = 'https://registry.npmjs.org/'
const MAX_PACKED_BYTES = 32 * 1024 * 1024
/** Scripts that would execute code during `npm publish` / `npm install`. */
const FORBIDDEN_SCRIPTS = [
  'preinstall',
  'install',
  'postinstall',
  'prepare',
  'prepublish',
  'prepack',
  'postpack',
  'dependencies',
]

const root = resolve(process.env.RELEASE_ROOT ?? process.cwd())
const problems = []
const passed = []
const fail = (message) => problems.push(message)
const pass = (message) => passed.push(message)

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const name = pkg.name
const version = pkg.version

/** Quote an argument for the Windows shell, where npm is a .cmd shim. */
const win = process.platform === 'win32'
const arg = (value) => (win && /\s/.test(value) ? `"${value}"` : value)
/**
 * Windows runs npm through a .cmd shim, so a shell is required there and the
 * command is assembled as one string (never an args array — Node deprecates
 * that, because a shell could only concatenate them). On CI (Linux) there is no
 * shell at all: argv goes straight to execve.
 */
const run = (cmd, args, options = {}) =>
  win
    ? execSync([cmd, ...args.map(arg)].join(' '), { cwd: root, encoding: 'utf8', ...options })
    : execFileSync(cmd, args, { cwd: root, encoding: 'utf8', ...options })

/* 1) the tag and package.json must agree ---------------------------------- */
if (process.env.REQUIRE_TAG === '0') {
  pass('not a `latest` release: tag check skipped by request')
} else {
  const wanted = `v${version}`
  let tags = []
  if (process.env.RELEASE_TAG) {
    tags = [process.env.RELEASE_TAG]
  } else {
    try {
      tags = run('git', ['tag', '--points-at', 'HEAD'])
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
    } catch (error) {
      fail(`could not read git tags: ${error.message}`)
    }
  }
  if (tags.includes(wanted)) pass(`HEAD carries tag ${wanted}`)
  else fail(`no tag ${wanted} on HEAD (found: ${tags.join(', ') || 'none'}) — tag the release commit first`)
}

/* 2) nothing that executes code at publish/install time ------------------- */
const scripts = pkg.scripts ?? {}
const forbidden = FORBIDDEN_SCRIPTS.filter((script) => script in scripts)
if (forbidden.length > 0) {
  fail(`package.json has publish/install-time lifecycle scripts: ${forbidden.join(', ')}`)
} else {
  pass(`no publish/install-time lifecycle scripts (present: ${Object.keys(scripts).join(', ') || 'none'})`)
}
// prepublishOnly is kept on purpose — it is the guard for a local `npm publish`.
// It can never reach a signing key: the staging job publishes a pre-built
// tarball with `--ignore-scripts`, and the build job has no id-token.
if ('prepublishOnly' in scripts && scripts.prepublishOnly !== 'npm run check') {
  fail(`scripts.prepublishOnly must be "npm run check" (found "${scripts.prepublishOnly}")`)
}

/* 3) publishConfig -------------------------------------------------------- */
const publishConfig = pkg.publishConfig ?? {}
if (publishConfig.registry !== undefined && publishConfig.registry !== REGISTRY) {
  fail(`publishConfig.registry must be ${REGISTRY} (found ${publishConfig.registry})`)
}
if (publishConfig.access !== 'public') fail(`publishConfig.access must be "public" (found ${publishConfig.access})`)
if (publishConfig.tag !== undefined) fail('publishConfig.tag must not be pinned: the dist-tag comes from the run')
if (pkg.private === true) fail('package.json is marked "private": true and cannot be published')
if (problems.length === 0) pass('publishConfig targets the official registry and is public')

/* 4) every dependency must be a registry version range -------------------- */
const DEP_FIELDS = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
  'bundledDependencies',
]
const NON_REGISTRY = /^(file:|link:|portal:|workspace:|git\+|git:|https?:|github:|[^/]+\/[^/]+#)/
for (const field of DEP_FIELDS) {
  for (const [dep, range] of Object.entries(pkg[field] ?? {})) {
    if (typeof range === 'string' && NON_REGISTRY.test(range)) {
      fail(`${field}.${dep} = "${range}" is not a registry range (git/file dependencies execute code on install)`)
    }
  }
}
if (!problems.some((problem) => problem.includes('not a registry range'))) {
  pass('every dependency is declared as a registry version range')
}

/* 5) no credential, and no way to mint one, in this job ------------------ */
if (existsSync(join(root, '.npmrc'))) {
  fail('the repository root contains .npmrc: registry and tokens must come from CLI flags only')
} else {
  pass('no .npmrc in the repository')
}
const tokenVars = Object.keys(process.env).filter((key) =>
  /^(NPM_TOKEN|NODE_AUTH_TOKEN|NPM_CONFIG__AUTH|NPM_CONFIG__AUTHTOKEN)$/i.test(key),
)
if (tokenVars.length > 0) fail(`npm token variables are present in the environment: ${tokenVars.join(', ')}`)
if (process.env.CI) {
  if (process.env.ACTIONS_ID_TOKEN_REQUEST_URL || process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN) {
    fail('this build job can request an OIDC token: `id-token: write` was added back to it. Signing ability must stay in the staging job')
  } else {
    pass('no OIDC and no npm token here (as intended: this job must not be able to sign)')
  }
}

/* 6) pack once and inspect exactly what would ship ----------------------- */
// Pack into a private directory and only hand the tarball over once every check
// has passed: a failing gate must not leave a stageable artifact behind.
const workDir = mkdtempSync(join(tmpdir(), `${name.replace(/[@/]/g, '-')}-pack-`))
const packDir = process.env.RELEASE_PACK_DIR ? resolve(process.env.RELEASE_PACK_DIR) : workDir

let pack
try {
  const raw = run('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', workDir])
  pack = JSON.parse(raw.slice(raw.indexOf('[')))[0]
} catch (error) {
  console.error('::error::npm pack failed, so the published contents cannot be determined')
  console.error(error.stdout ?? '')
  console.error(error.stderr ?? error.message)
  process.exit(1)
}

const packed = pack.files.map((file) => file.path.replaceAll('\\', '/')).sort()

// The allowlist is derived from package.json `files`, so it stays correct as
// the package layout evolves — there is no second place to forget to update.
const escapeRe = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const globToRe = (value) => escapeRe(value).replace(/\\\*\\\*/g, '.*').replace(/\\\*/g, '[^/]*')
const entryToRe = (entry) => {
  const clean = entry.replaceAll('\\', '/').replace(/\/+$/, '')
  if (clean.endsWith('/*')) return new RegExp(`^${globToRe(clean.slice(0, -1))}`) // a directory's contents, recursively
  if (clean.includes('*')) return new RegExp(`^${globToRe(clean)}$`)
  if (/\.[A-Za-z0-9]+$/.test(clean)) return new RegExp(`^${escapeRe(clean)}$`) // a single file
  return new RegExp(`^${escapeRe(clean)}(/.*)?$`) // a directory
}
// npm always includes these regardless of `files`.
const ALWAYS = /^(package\.json|LICEN[CS]E(\.[^/]+)?|README(\.[^/]+)?|CHANGELOG(\.[^/]+)?|NOTICE(\.[^/]+)?|HISTORY(\.[^/]+)?)$/
const allowed = [...(pkg.files ?? []).map(entryToRe), ALWAYS]

const outsideAllowlist = packed.filter((path) => !allowed.some((re) => re.test(path)))
if (outsideAllowlist.length > 0) {
  fail(`packed content is outside the package.json "files" allowlist: ${outsideAllowlist.slice(0, 10).join(', ')}`)
} else {
  pass(`${packed.length} packed files, all inside the package.json "files" allowlist`)
}

// The strongest content check available: anything in the tarball that git does
// not track was written during the build, which is exactly how a poisoned
// dependency would smuggle itself into the artifact.
let tracked = null
try {
  tracked = new Set(run('git', ['ls-files', '-z']).split('\0').filter(Boolean))
} catch (error) {
  fail(`could not run git ls-files (${error.message}): the gate needs .git, so do not drop history at checkout`)
}
if (tracked) {
  const untracked = packed.filter(
    (path) => !tracked.has(path) && !ALLOW_UNTRACKED.some((prefix) => path.startsWith(prefix)),
  )
  if (untracked.length > 0) {
    fail(`the tarball contains files git does not track: ${untracked.slice(0, 10).join(', ')} (files written during the build do not belong in a release)`)
  } else {
    pass('every packed file is a committed file (or a declared build output)')
  }
}

if (pack.size > MAX_PACKED_BYTES) {
  fail(`tarball is ${(pack.size / 1048576).toFixed(1)} MiB, over the ${MAX_PACKED_BYTES / 1048576} MiB cap`)
}

const collectTargets = (value, acc = []) => {
  if (typeof value === 'string') acc.push(value)
  else if (value && typeof value === 'object') for (const nested of Object.values(value)) collectTargets(nested, acc)
  return acc
}
const exportsTargets = collectTargets(pkg.exports)
const packedSet = new Set(packed)
for (const target of exportsTargets) {
  if (!target.startsWith('./')) {
    fail(`exports target "${target}" is not a relative path`)
    continue
  }
  const rel = target.slice(2)
  if (rel.includes('*')) {
    // A wildcard entry ("./src/*": "./src/*") is satisfied by any packed match.
    const re = new RegExp(`^${globToRe(rel)}$`)
    if (!packed.some((path) => re.test(path))) fail(`exports wildcard "${target}" matches nothing in the tarball`)
    continue
  }
  if (!packedSet.has(rel)) fail(`exports target "${target}" is not in the tarball`)
  else if (!existsSync(join(root, rel))) fail(`exports target "${target}" does not exist on disk`)
}
if (exportsTargets.length > 0 && !problems.some((problem) => problem.includes('exports'))) {
  pass(`all ${exportsTargets.length} exports entries are present`)
}

/* 7) evidence: the bytes the staging job must reproduce ------------------- */
const tarballPath = join(workDir, pack.filename)
const bytes = readFileSync(tarballPath)
const integrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`
const shasum = createHash('sha1').update(bytes).digest('hex')
if (pack.integrity && pack.integrity !== integrity) {
  fail(`npm reported integrity ${pack.integrity} but the bytes hash to ${integrity}`)
} else {
  pass(`tarball ${pack.filename} (${(bytes.length / 1048576).toFixed(2)} MiB) ${integrity}`)
}

const evidence = {
  name,
  version,
  integrity,
  shasum,
  fileCount: packed.length,
  tarballBytes: bytes.length,
  unpackedSize: pack.unpackedSize,
  files: packed,
}
const evidencePath = resolve(process.env.RELEASE_EVIDENCE ?? join(root, 'release-evidence.json'))

/* result ------------------------------------------------------------------ */
for (const line of passed) console.log(`  ok   ${line}`)
if (problems.length > 0) {
  console.error('')
  for (const line of problems) {
    console.error(`::error::${line}`)
    console.error(`  fail ${line}`)
  }
  console.error(`\nrelease gate failed: ${problems.length} check(s) unmet, nothing was staged. No artifact was left behind.`)
  process.exit(1)
}

// Checks passed: hand over the tarball and the evidence that describes it.
if (packDir !== workDir) {
  mkdirSync(packDir, { recursive: true })
  copyFileSync(tarballPath, join(packDir, pack.filename))
}
writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 4)}\n`)

if (process.env.GITHUB_OUTPUT) {
  appendFileSync(process.env.GITHUB_OUTPUT, `integrity=${integrity}\nversion=${version}\nfilename=${pack.filename}\n`)
}
if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(
    process.env.GITHUB_STEP_SUMMARY,
    [
      `### Release evidence: \`${name}@${version}\``,
      '',
      `- tarball: \`${pack.filename}\` (${packed.length} files, ${(bytes.length / 1048576).toFixed(2)} MiB)`,
      `- **integrity**: \`${integrity}\``,
      `- shasum: \`${shasum}\``,
      '',
      'The staging job re-hashes these same bytes before uploading anything. Before',
      'approving the stage, check that the integrity npm shows matches the value above.',
      '',
      '<details><summary>Packed contents</summary>',
      '',
      ...packed.map((path) => `- ${path}`),
      '',
      '</details>',
      '',
    ].join('\n'),
  )
}

console.log(`\nRELEASE_INTEGRITY=${integrity}`)
console.log(`RELEASE_TARBALL=${tarballPath}`)
console.log(`RELEASE_EVIDENCE=${evidencePath}`)
console.log('\nrelease gate passed.')
