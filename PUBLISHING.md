# Publishing

`@citisen/dsh-ui-polish` is published in two halves:

1. **CI stages** a tarball — `.github/workflows/stage.yml`, over npm
   [trusted publishing](https://docs.npmjs.com/trusted-publishers). No secret is
   involved.
2. **A human approves** it, via [staged publishing](https://docs.npmjs.com/staged-publishing),
   which requires that human's 2FA.

There is no `NPM_TOKEN` in this repository and there must never be one.

## Why this is safer than a token

A publish token is a bearer secret: anything that can read it can publish to the
package from anywhere, forever, until someone notices and rotates it. It usually
has to bypass 2FA to be usable by a machine, which removes the one control that
would otherwise stop an attacker.

Trusted publishing replaces the secret with a **short-lived OIDC identity** that
GitHub mints per run and npm exchanges for a staging grant. Nothing to steal,
nothing to leak into a log, nothing to rotate. The grant is scoped to this
repository, this workflow file, and the `npm-publish` environment, so it cannot
be replayed from another repo or a laptop. npm attaches a signed provenance
attestation automatically.

## Why staged rather than direct

npm's trusted-publisher form offers an **Allowed actions** checkbox for
`npm publish`, and warns that leaving it unchecked is stronger. That warning is
correct, and this repository leaves it **unchecked**.

Checked, the workflow's OIDC grant can publish unattended — so anything that can
run the workflow puts a version on the registry and makes it installable,
immediately, with no further check.

Unchecked, the same grant can only *stage*. `npm stage publish` uploads the
tarball and stops; nothing is installable, and `npm view` still reports the
previous version. Publishing then needs `npm stage approve`, which npm gates on
the maintainer's 2FA. A compromised runner, a malicious commit, or a bad
dependency in CI gets as far as a staged tarball that a human still has to look
at and approve.

That human step is what holds the security boundary in practice, because trusted
publishing moves the trust boundary from *whoever holds the token* to *whoever
can push*. `main` is therefore protected like the sibling package:
required PR, linear history, no force pushes, no deletions, and
`enforce_admins: true` — so a mistaken direct push is refused for the maintainer
too.

**The strongest configuration is all three: staging, a protected `main`, and a
protected `npm-publish` environment.** The third one is opt-in (see below).

## Bootstrapping: the first release is by hand

A trusted publisher is configured on the package's own settings page, so a
package that does not exist yet cannot have one. Sequence for the very first
release:

1. `npm login`, then `npm run check`, then `npm publish --access public`
   (0.1.0, with your 2FA).
2. Configure the trusted publisher as below.
3. Cut the next patch through CI staging and approve it — that proves the OIDC
   path works end to end.
4. Revoke the local token and remove the `_authToken` line from `~/.npmrc`.

Once step 3 has succeeded, no local credential needs publish rights again.

## One-time setup

### 1. Configure the trusted publisher on npm

<https://www.npmjs.com/package/@citisen/dsh-ui-polish/access> → **Trusted
Publishers** → *Add a trusted publisher* → **GitHub Actions**, and enter exactly:

| Field | Value |
| --- | --- |
| Organization or user | `citisen` |
| Repository | `dsh-ui-polish` |
| Workflow filename | `stage.yml` |
| Environment | `npm-publish` |
| Allowed actions | leave **`npm publish` UNCHECKED** (staged publishing only) |

The filename is matched literally and must live at
`.github/workflows/stage.yml`. **Renaming or moving that file stops CI staging**
until you update this setting. The environment must match the `environment:` key
in the workflow; to skip the reviewer gate, remove that key from both.

### 2. Set publishing access, then revoke every token

On the same page set **Publishing access** to *Require two-factor authentication
and disallow tokens*.

Then delete every credential that could still publish:
<https://www.npmjs.com/settings/~/tokens> → revoke any **Automation** or
**Granular** token with publish rights, especially any with *bypass 2FA*
enabled. Remove the `//registry.npmjs.org/:_authToken=...` line from `~/.npmrc`
on every machine once you stop releasing by hand.

Skipping this leaves the old door open — the OIDC path being locked down says
nothing about a token that is still live.

**`npm publish --dry-run` cannot verify this.** Trusting it is the trap this
paragraph used to set: a dry run packs the tarball locally and reports, and npm
deliberately downgrades even a *missing credential* to a warning in that mode —
from its own `lib/commands/publish.js`:

```js
if (noCreds) {
  const msg = `This command requires you to be logged in to ${outputRegistry}`
  if (dryRun) {
    log.warn(this.#command, `${msg} (dry-run)`)
  } else {
    throw Object.assign(new Error(msg), { code: 'ENEEDAUTH' })
  }
}
```

A dry run does catch a version that is already published (it reads the packument
first), which is worth knowing — but it says nothing about who may write.

Verify the reduction where the setting actually lives:

- The package page's **Settings → Publishing access** reads *Require two-factor
  authentication and disallow tokens*.
- The token page lists no **Automation** or **Granular** token with publish
  rights for this scope, and `~/.npmrc` has no `registry.npmjs.org` auth token
  left on a machine you release from.

The only *dynamic* proof is a real publish that fails, and that is not worth
running against a live package. It is also unnecessary: with tokens disallowed,
the OIDC grant plus a human approval is the only path that can put a version on
the registry — which is exactly what the staging workflow exercises on every
release, and what the first CI staging run of this package demonstrated.

### 3. Optionally gate staging on a reviewer

Create an environment named `npm-publish` in *Settings → Environments* and add
required reviewers. The workflow already references it; no edit is needed. GitHub
also creates the environment on the first run, with no protection rules — which
is why this step is worth doing deliberately.

## Cutting a release

```sh
# on main, through a PR
npm version patch --no-git-tag-version   # or minor / major
git commit -am "Release v0.1.1"
git tag v0.1.1
git push --follow-tags
```

Then **Actions → Stage release → Run workflow**, pick the dist-tag, and type the
version to confirm. The full runbook, including the PR step, is in
[RELEASING.md](RELEASING.md).

The workflow refuses to run when:

- the typed confirmation does not match `package.json`
- `npm run check` fails — `lib/client.js` does not match `src/client.js`, or the
  envelope, the fix registry, the wheel bridge, or the settings row is broken
- the version is already published **or already staged**
- you asked for `latest` without a `v<version>` tag pointing at exactly the
  commit being released

It also deletes any `.npmrc` and unsets `NODE_AUTH_TOKEN`/`NPM_TOKEN` first, so a
stray credential fails closed instead of quietly overriding the OIDC exchange.

### Approving

```sh
npm run release -- list                  # find the stage-id
npm run release -- view <stage-id>       # inspect before trusting it
npm run release -- approve <stage-id>    # publishes; requires your 2FA
npm run release -- reject <stage-id>     # discard
```

The helper delegates to `npx npm@12` because `npm stage` needs npm ≥ 11.6 (12 for
the current subcommands) and Node 22.22 / 24.15 / 26+, which the local Node may
not satisfy. `approve` is the only step that publishes, and npm demands your 2FA
there.

Inspect the staged tarball before approving a release you did not build yourself
— `npm run release -- download <stage-id>` fetches it. That is the whole value of
the gate: the approval is only meaningful if the artifact is actually looked at.

## Verifying a published release

```sh
npm view @citisen/dsh-ui-polish --json | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);const v=j['dist-tags'].latest;console.log(v, j.versions[v].dist.integrity);console.log(j.versions[v].dist.attestations)})"
```

For an end-to-end check, install into a scratch profile and verify — composition
first, then the shipped code itself:

```sh
dsh plugin --profile scratch add @citisen/dsh-ui-polish
node scripts/verify-profile.mjs scratch
# both halves of the PUBLISHED copy, not the working tree
node scripts/verify-host.mjs   "$DSH_HOME/profiles/scratch/node_modules/@citisen/dsh-ui-polish/lib/index.js"
node scripts/verify-client.mjs "$DSH_HOME/profiles/scratch/node_modules/@citisen/dsh-ui-polish/lib/client.js"
```

A `files` entry missing from `package.json` is invisible locally and fatal
remotely, so a published artifact has to be exercised from where it was
installed — and note that importing through a profile's directory junction
resolves to the junction's real path, which is why the explicit paths matter.
