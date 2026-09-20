# Releases publish from a tag push

## Problem

Cutting a release was three unconnected manual steps: `git tag vX.Y.Z`, push the
tag, `gh release create`. The repository ran CI on `main` and `develop`, but a
tag push triggered nothing — no gate stood between a tag and the version users
install, and nothing obliged anyone to create the Release at all.

That last gap is not hypothetical. A tag was pushed and its Release was never
created, so the version existed as a git ref with no release page, no notes and
no entry in the Releases list. Nothing here could have caught the omission,
because nothing watched tags. A user pinning that tag gets a working install; a
user browsing Releases sees a version that appears never to have shipped.

## Decision

`.github/workflows/release.yml`, one job on `push: tags: ["v*"]`:

1. `actions/checkout@v7` with `fetch-depth: 0` — `--generate-notes` needs the
   history to diff against the previous tag — and `ref` set to the tag under
   release, so the gates test the tagged tree rather than a branch tip.
2. `actions/setup-node@v7` on Node 22: the declared `engines` floor, the major
   `.github/workflows/ci.yml` already runs, and new enough that `node --test`
   strips types without a flag, so the `.ts` suite runs unmodified.
3. `npm ci`, then the gates as two steps — `node --test "test/**/*.test.ts"` and
   `npx tsc --noEmit`. A red gate ends the job before any release call.
4. `gh release create "$TAG" --generate-notes --verify-tag`, with
   `GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}`.

`permissions: contents: write` sits on the job, not the workflow, so the write
scope belongs to the one job that creates a Release; scopes left unlisted
resolve to `none`.

**Idempotence.** The publish step probes with `gh release view "$TAG"` and exits
0 when the Release exists, so re-running either trigger publishes nothing and
still reports success. Probe-then-create is not atomic, so a `concurrency` group
keyed on the target tag serialises the two triggers.

**Backfill.** `workflow_dispatch` takes a tag name, for tags pushed before this
workflow existed. The input travels through `env` rather than into the script
text, and must match `v*` and resolve to an existing `refs/tags/<tag>` commit —
a branch name or a typo fails the job rather than releasing something
unintended. The manual path drops `--latest`, since backfilling an older tag
must not move the "Latest" pointer; gh's own default (date and version) decides.
`--verify-tag` on both paths refuses to let gh invent a missing tag from the
default branch — the failure mode this workflow exists to prevent.

## Alternatives considered

1. **Keep releasing by hand.** Strongest reason: a release stays one command,
   the repository grows no new CI surface, and whoever tags writes the notes
   deliberately instead of accepting a generated list. Why rejected: this is the
   process that produced the missing Release. The tag push and the release call
   were separate steps with nothing linking them, and skipping the second is
   silent — the omission surfaces only when someone looks for the version and
   cannot find it.
2. **semantic-release or release-please.** Strongest reason: version, tag,
   changelog and Release all derive from commit messages, so no step is left to
   forget. Why rejected: both take ownership of the version number and the tag
   itself, which makes conventional-commit messages load-bearing and every bump
   a bot commit on `main`. This repository releases a handful of times per
   cycle; the machinery would cost more than the step it removes, and it hands a
   third-party tool the tags users pin.
3. **Add a `release` job to the existing ci.yml.** Strongest reason: one
   workflow file, and the gates are literally the same steps, so the tag path
   and the branch path cannot drift apart. Why rejected: the two differ in
   trigger, permission and meaning — ci.yml runs read-only on every branch push,
   while this job needs `contents: write` and must never run there. Splitting
   them keeps `contents: read` the default for the workflow that runs most
   often, which is what per-job scoping is for.
4. **Skip the gates on the tag push, since the commit already passed CI on
   `main`.** Strongest reason: that commit was green on the branch, so re-running
   the suite doubles the work for the same verdict. Why rejected: a tag can point
   anywhere — a backfill names an old commit, and `--generate-notes` will publish
   it regardless. The gates cost minutes and make the tag itself the verified
   object, instead of a commit that merely shared its hash.
5. **Tag and release from a local script.** Strongest reason: it keeps the
   release on one machine, spends no Actions minutes, and can be debugged
   interactively. Why rejected: it reintroduces the exact failure that motivated
   this work — a local script still has to be remembered and run, and its result
   is invisible to the next person reading the Releases page.

## Consequences

- Pushing a tag is the whole release procedure on the happy path; the Release
  appears only after the suite and typecheck pass on that commit.
- The `v0.6.1` tag predates this workflow and has no Release;
  `workflow_dispatch` with `v0.6.1` publishes it.
- `.github/workflows/ci.yml` still pins `actions/checkout@v4` and
  `actions/setup-node@v4` while `release.yml` pins `@v7`. Both work, but the
  drift is real and ci.yml should be bumped the next time it is touched.
- The workflow pins Node 22 while local development may run newer, so the gates
  prove the `engines` floor rather than the newest runtime.
- Nothing rejects a malformed tag such as `v1`: the gates pass and a Release is
  created. Enforcing a tag shape needs a check that knows the previous tag,
  which is a separate decision.
