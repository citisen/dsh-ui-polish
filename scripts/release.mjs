/**
 * Maintainer-side release helper.
 *
 * Publishing is split in two on purpose: CI stages a tarball (see
 * `.github/workflows/stage.yml`), and a human approves it here, where npm
 * demands that human's 2FA. A compromised runner or a malicious commit can
 * therefore stage but never publish.
 *
 * `npm stage` needs npm >= 11.6 (12 for the current subcommands) and Node 22.22
 * / 24.15 / 26+, which the local Node may not satisfy. So rather than requiring
 * a global npm upgrade, this delegates to `npx npm@12`, and borrows the system
 * `git` for the OTP flow npm uses for a 2FA-gated web approval.
 *
 * Usage:
 *   node scripts/release.mjs list [package]
 *   node scripts/release.mjs view <stage-id>
 *   node scripts/release.mjs approve <stage-id> [--expect <sha512-…>]
 *   node scripts/release.mjs reject <stage-id>
 *   node scripts/release.mjs download <stage-id> [--dry-run]
 *
 * `--expect` is the last mile: approving is the moment something becomes
 * installable, and a stage-id on its own does not say *what* is in the queue.
 * Pass the integrity the CI run summary printed and approve refuses to run
 * unless the staged tarball hashes to exactly that — so "approve the thing CI
 * built" is checked instead of assumed. It fails closed: if the download cannot
 * be verified, nothing is approved.
 */

import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const [, , subcommand, ...rest] = process.argv

const PACKAGE_NAME = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).name
const VERSION = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version

/** npm CLI major to run; `npm stage` needs 12 for `list`/`approve`. */
const NPM_SPEC = 'npm@12'
/** Where npm writes files it downloads. Checked for the staged tarball. */
const DOWNLOAD_DIRS = [root, tmpdir()]

const USAGE = `usage: node scripts/release.mjs <command> [args]

  list [package]                     staged versions (default: ${PACKAGE_NAME})
  view <stage-id>                    details of one staged version
  approve <stage-id> [--expect <…>]  publish it — REQUIRES your 2FA
  reject <stage-id>                  discard it
  download <stage-id>                fetch the staged tarball for inspection

Nothing here publishes without an approval, which is the point: CI can only
stage. Copy the integrity from the CI run summary and approve in one checked
step: node scripts/release.mjs approve <stage-id> --expect sha512-…`

const KNOWN = new Set(['list', 'view', 'approve', 'reject', 'download'])

const runNpx = (args) =>
  spawnSync('npx', ['--yes', NPM_SPEC, ...args], {
    cwd: root,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  })

const sha512Of = (path) => `sha512-${createHash('sha512').update(readFileSync(path)).digest('base64')}`

const tarballsIn = (dir) => {
  try {
    return readdirSync(dir)
      .filter((entry) => entry.endsWith('.tgz'))
      .map((entry) => join(dir, entry))
  } catch {
    return []
  }
}

/**
 * Download the staged tarball and refuse to go on unless its bytes hash to the
 * integrity CI printed. Anything unexpected is a refusal, never an approval.
 */
const verifyStaged = (stageId, expected) => {
  const before = new Set(DOWNLOAD_DIRS.flatMap(tarballsIn))
  console.log(`release: downloading stage ${stageId} to check it against ${expected}`)

  if (runNpx(['stage', 'download', stageId]).status !== 0) {
    console.error('release: could not download the staged tarball, so its contents could not be checked.')
    console.error('release: refusing to approve. Inspect it yourself, then re-run without --expect if you accept it.')
    process.exit(1)
  }

  const candidates = DOWNLOAD_DIRS.flatMap(tarballsIn).filter((path) => !before.has(path))
  if (candidates.length === 0) {
    console.error('release: the download produced no new .tgz to hash, so the stage could not be checked.')
    console.error('release: refusing to approve. Inspect it yourself, then re-run without --expect if you accept it.')
    process.exit(1)
  }

  const match = candidates.find((path) => sha512Of(path) === expected)
  if (match === undefined) {
    console.error('release: the staged tarball does not match the integrity CI built:')
    for (const path of candidates) console.error(`  ${sha512Of(path)}  ${path}`)
    console.error(`  expected ${expected}`)
    console.error('release: REFUSING to approve — this stage is not the artifact CI produced.')
    process.exit(1)
  }
  console.log(`release: verified — the staged tarball is the one CI built (${match})`)
}

// `--expect` is pulled out of the arguments so a stage-id can sit anywhere.
let expect = null
const positional = []
for (let index = 0; index < rest.length; index += 1) {
  const value = rest[index]
  if (value === '--expect') {
    expect = rest[index + 1] ?? ''
    index += 1
  } else if (value.startsWith('--expect=')) {
    expect = value.slice('--expect='.length)
  } else {
    positional.push(value)
  }
}

if (subcommand === undefined || subcommand === '--help' || subcommand === '-h') {
  console.log(USAGE)
  process.exit(0)
}
if (!KNOWN.has(subcommand)) {
  console.error(`release: unknown command "${subcommand}"\n\n${USAGE}`)
  process.exit(2)
}
if (subcommand !== 'list' && positional.length === 0) {
  console.error(`release: "${subcommand}" needs a stage-id\n\n${USAGE}`)
  process.exit(2)
}
if (expect !== null && subcommand !== 'approve') {
  console.error(`release: --expect only means something with "approve" (got "${subcommand}")\n\n${USAGE}`)
  process.exit(2)
}
if (expect !== null && !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(expect)) {
  console.error('release: --expect wants a sha512 integrity, e.g. sha512-1B2c…=')
  process.exit(2)
}

const stageArgs = ['stage', subcommand]
if (subcommand === 'list') stageArgs.push(positional[0] ?? PACKAGE_NAME)
else stageArgs.push(...positional)

if (subcommand === 'approve') {
  if (expect === null) {
    console.warn('release: no --expect given, so what is staged is not being compared with what CI built.')
    console.warn(`release: the CI run summary prints it; re-run as: approve ${positional[0]} --expect <sha512-…>`)
  } else {
    verifyStaged(positional[0], expect)
  }
  console.log('release: approving publishes to the registry and requires your 2FA')
}

console.log(`release: npx ${NPM_SPEC} ${stageArgs.join(' ')}`)
const result = runNpx(stageArgs)

if (result.error !== undefined) {
  if (result.error.code === 'ENOENT') {
    console.error('release: npx not found on PATH — install Node.js')
    process.exit(127)
  }
  throw result.error
}
const exitCode = result.status ?? 1

if (exitCode === 0 && subcommand === 'list') {
  console.log(`\nrelease: nothing is installable until a stage is approved.`)
  console.log(`release: a local release runs \`npm run release -- approve <stage-id> --expect <integrity>\` from v${VERSION}.`)
}

process.exit(exitCode)
