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
 *   node scripts/release.mjs approve <stage-id>
 *   node scripts/release.mjs reject <stage-id>
 *   node scripts/release.mjs download <stage-id> [--dry-run]
 */

import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const [, , subcommand, ...rest] = process.argv

const PACKAGE_NAME = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).name
const VERSION = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version

/** npm CLI major to run; `npm stage` needs 12 for `list`/`approve`. */
const NPM_SPEC = 'npm@12'

const USAGE = `usage: node scripts/release.mjs <command> [args]

  list [package]            staged versions (default: ${PACKAGE_NAME})
  view <stage-id>           details of one staged version
  approve <stage-id>        publish it — REQUIRES your 2FA
  reject <stage-id>         discard it
  download <stage-id>       fetch the staged tarball for inspection

Nothing here publishes without an approval, which is the point: CI can only
stage.`

const KNOWN = new Set(['list', 'view', 'approve', 'reject', 'download'])

if (subcommand === undefined || subcommand === '--help' || subcommand === '-h') {
  console.log(USAGE)
  process.exit(0)
}
if (!KNOWN.has(subcommand)) {
  console.error(`release: unknown command "${subcommand}"\n\n${USAGE}`)
  process.exit(2)
}
if (subcommand !== 'list' && rest.length === 0) {
  console.error(`release: "${subcommand}" needs a stage-id\n\n${USAGE}`)
  process.exit(2)
}

const args = [NPM_SPEC, 'stage', subcommand]
if (subcommand === 'list') args.push(rest[0] ?? PACKAGE_NAME)
else args.push(...rest)

console.log(`release: npx ${args.join(' ')}`)
if (subcommand === 'approve') {
  console.log('release: approving publishes to the registry and requires your 2FA')
}

const result = spawnSync('npx', ['--yes', ...args], {
  cwd: root,
  stdio: 'inherit',
  shell: process.platform === 'win32',
})

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
  console.log(`release: a local release runs \`npm run release -- approve <stage-id>\` from v${VERSION}.`)
}

process.exit(exitCode)
