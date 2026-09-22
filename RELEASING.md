# Releasing

The runbook for changing the plugin and getting it to users. For the *why*
behind the setup (and what it does not protect against), see
[PUBLISHING.md](PUBLISHING.md).

The next version to ship is **0.1.4**, and it is the last one: **this package is
deprecated**, so nothing should be staged after it.

dsh absorbed the one behaviour it shipped: since `0.1.7-alpha.1` the conversation's width
handle bridges the wheel itself (`WidthHandle` renders with an `onWheel` that scrolls the
`[data-conversation-scroll]` beside it). The plugin is still the only thing that makes
the wheel work over those strips on `0.1.5-rc.x`, so `0.1.4` carries the fix that gets
both lines right rather than guessing which one it is on:

- `0.1.3`, staged and **must not be published**, tried to stand the fix down when it
  inferred that the host owned the wheel — from the shape of the DOM instead of from
  what happened. Both lines render the handle as a sibling of the scroll element, so it
  stood down on the line that has no bridge of its own and the strips swallowed the
  wheel again. `0.1.4` queues its scroll behind the rest of the event and applies it only
  if the host did not move the scroller first: no double speed on `0.1.7`, no dead strip
  on `0.1.5`.
- It also carries the settings read fix (`value` over `user` on the `0.1.7` line) and the
  README's deprecation notice.

**Reject the staged `0.1.3`**, stage `0.1.4`, and then mark every published version
deprecated:

```sh
npm deprecate '@citisen/dsh-ui-polish' 'Deprecated: dsh does this itself since 0.1.7-alpha.1 (the width handle bridges the wheel). On 0.1.5-rc.x this version still makes the wheel pass through the strips. 0.1.4 is the final release.'
```

The published `latest` is `0.1.2`; the section below describes how releases are made
if the package is ever revived, and `0.1.1` was the first release staged by CI and
approved from there, so the OIDC path is no longer merely configured: it has run, and
it produced a tarball with provenance attached. `0.1.0` was published by hand once,
before trusted publishing could be configured for it (see
[Bootstrapping](#bootstrapping-the-first-release)). Every release from here goes
through staging, and a local `npm publish` failing is the setup working rather
than the setup broken.

## The short version

```sh
# 1. edit code, then get the generated bundle back in sync
npm run build

# 2. prove it (needs a local dsh; otherwise it skips that last check)
npm run check:all

# 3. bump the version
npm version patch --no-git-tag-version   # or minor / major

# 4. land it through a PR (main is protected — direct pushes are rejected)
git checkout -b fix/whatever
git commit -am "Describe the change"
git push -u origin fix/whatever
gh pr create --fill && gh pr merge --squash --delete-branch

# 5. tag the merged commit, then stage
git checkout main && git pull --ff-only
git tag v0.1.2 && git push origin v0.1.2
gh workflow run stage.yml --ref main -f dist-tag=latest -f confirm=0.1.2

# 6. review, then approve (this is the only step that publishes)
npm run release -- list                  # find the stage-id
npm run release -- view <stage-id>
npm run release -- approve <stage-id>

# 7. confirm users can get it
npm view @citisen/dsh-ui-polish dist-tags
```

## Bootstrapping the first release

*Already done for `0.1.0`.* Kept for two reasons: a new package in this series
needs the same three steps, and it is the record of why a local publish must no
longer be possible.

Trusted publishing is configured on a package's **own settings page**, so a
package that does not exist yet cannot be configured for it. The first release is
therefore published by hand, once:

1. Publish `0.1.0` locally with your 2FA:

   ```sh
   npm login
   npm run check
   npm publish --access public
   ```

2. Configure the trusted publisher for it: see
   [PUBLISHING.md](PUBLISHING.md#one-time-setup). From then on, CI can stage and
   nothing local needs publish rights at all.

3. Verify the OIDC path actually works by cutting `0.1.1` through steps 3–6 above
   — a staged tarball that a human approves, with no token involved.

Keep the local token only until step 3 has succeeded, then revoke it.

## Step detail

### 1. Edit and rebuild

`src/client.js` → `lib/client.js` is a build, not a hand-edit.
**`lib/client.js` is generated and committed** — if you edit it directly the next
build overwrites you, and `lib/index.js` is the only half you edit in place.

```sh
npm run build     # src/client.js -> lib/client.js
npm run watch     # rebuild on save, while `dsh --profile web` runs elsewhere
```

### 2. Prove it

```sh
npm run check      # bundle in sync + host half + client half
npm run check:all  # also composes a real profile to confirm the loader sees it
```

`check:all` needs a dsh installation and an initialized profile, and **skips that
one check** when they are absent. Run it locally anyway: it is the only check
that catches a `cordis.patch.yml` that no longer resolves, which shows up in the
browser as nothing happening at all.

If you changed a fix, also exercise it by hand — a passing verifier is not the
same as a working interface, and these fixes act on pointer behaviour that no
stub reproduces exactly:

```sh
dsh --profile web    # then hover the conversation's side gutter and scroll
```

### 3. Bump the version

```sh
npm version patch --no-git-tag-version   # or minor / major
```

`--no-git-tag-version` matters: it stops npm from creating the tag on the
pre-merge commit. The tag has to point at the commit on `main`, and the workflow
checks that with `git tag --points-at HEAD`.

### 4. Land it through a PR

`main` is protected with `enforce_admins: true`, so **even you cannot push to it
directly**. This is deliberate: the publishing grant trusts the repository, so
push access effectively *is* publish access.

Required approvals is 0, because GitHub will not let you approve your own PR; you
can `gh pr merge --squash` your own work. Linear history is required, so squash
or rebase rather than merge-commit.

### 5. Tag, then stage

```sh
git tag v0.1.2 && git push origin v0.1.2
gh workflow run stage.yml --ref main -f dist-tag=latest -f confirm=0.1.2
```

The `confirm` input must equal `package.json`'s version exactly — it exists to
catch a wrong-version release.

The workflow refuses to stage when:

| Refusal | Meaning |
| --- | --- |
| confirmation ≠ `package.json` version | wrong version typed |
| `npm run check` fails | the bundle is stale, or a half is broken |
| version already published **or staged** | bump it; approve or reject the old stage first |
| `latest` without a `v<version>` tag on that exact commit | tag the merged commit first |

It also deletes any `.npmrc` and unsets `NODE_AUTH_TOKEN`/`NPM_TOKEN` before
staging, so a stray credential fails closed rather than quietly overriding the
OIDC exchange.

### 6. Review, then approve

**Staging is not publishing.** After a successful run nothing is installable:
`npm view @citisen/dsh-ui-polish version` still reports the previous release. A
human must approve, and npm gates that on 2FA.

```sh
npm run release -- list                  # find the stage-id
npm run release -- view <stage-id>       # metadata, and who staged it
npm run release -- download <stage-id>   # the tarball itself
npm run release -- approve <stage-id>    # publishes — requires 2FA
npm run release -- reject <stage-id>     # discard it
```

`npm run release` exists because `npm stage` needs npm ≥ 12 while this machine's
npm may be older; the helper runs `npx npm@12` so you never have to upgrade
globally. The bare `npm stage ...` commands npm's website shows **will not work
here** — `Unknown command: "stage"`. Keep the `run release --` prefix and the `--`.

Reviewing properly means checking `staged by:` reads
`GitHub Actions (trusted automation)`, and — if you did not build it yourself —
actually opening the downloaded tarball. Approving on autopilot turns the gate
into a click.

### 7. Confirm

```sh
npm view @citisen/dsh-ui-polish dist-tags        # latest should now be the new version
```

Then verify the *published* artifact, not just the working tree — a `files` entry
missing from `package.json` is invisible locally and fatal remotely:

```sh
dsh plugin --profile scratch add @citisen/dsh-ui-polish
node scripts/verify-profile.mjs scratch
node scripts/verify-host.mjs   "$DSH_HOME/profiles/scratch/node_modules/@citisen/dsh-ui-polish/lib/index.js"
node scripts/verify-client.mjs "$DSH_HOME/profiles/scratch/node_modules/@citisen/dsh-ui-polish/lib/client.js"
```

## Things that will bite you

**A published version cannot be reused, and may not be deletable.** npm allows
unpublishing only within 72 hours and discourages it; beyond that the version
number is burned. If you ship something broken, publish a patch.

**A pushed tag cannot be moved.** `allow_force_pushes` is off, and moving a tag
would defeat the ancestry check anyway. Tagged a commit and then found a problem?
Bump the version and tag again.

**`lib/client.js` must be committed.** The workflow and any `npm install` from
git use the committed file; it does not build on install.

**A fix that only works in one dsh version needs a switch, not a hotfix.** The
whole point of the per-fix toggles is that a layout change upstream is a user
setting away from being harmless.

## Quick reference

| Task | Command |
| --- | --- |
| Rebuild the browser bundle | `npm run build` |
| Rebuild on save | `npm run watch` |
| Full local gate | `npm run check:all` |
| Bump version | `npm version patch --no-git-tag-version` |
| Open + merge a PR | `gh pr create --fill && gh pr merge --squash --delete-branch` |
| Tag and stage | `gh workflow run stage.yml --ref main -f dist-tag=latest -f confirm=<version>` |
| List stages | `npm run release -- list` |
| Review a stage | `npm run release -- view <stage-id>` |
| Publish (2FA) | `npm run release -- approve <stage-id>` |
| Discard a stage | `npm run release -- reject <stage-id>` |
| Check what users get | `npm view @citisen/dsh-ui-polish dist-tags` |
