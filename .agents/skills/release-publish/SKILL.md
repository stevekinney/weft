---
name: release-publish
description: >-
  Use this skill when cutting, preparing, validating, publishing, or
  troubleshooting a Weft npm release for @lostgradient/weft.
---

> Monorepo note: all repository paths and commands in this skill are relative to `packages/weft/` unless a path explicitly starts with `packages/`.

# Release Publish

## Release contract

Publish Weft through the GitHub Actions release workflow, not by defaulting to a
local `npm publish`. The workflow runs on every push to `main`, after
`verify` (package.json and `src/version.ts` agree) and `verify-mirror` (the
`mirror-verify.yaml` build, typecheck, pack, and consumer gates) pass. It runs
two jobs:

1. `bun run release:publish` (`scripts/publish-if-missing.ts`) publishes any
   version npm does not have yet. If npm already has the manifest version, it
   logs that it is skipping the publish and publishes nothing. Otherwise it
   refuses to publish when the remote `v<version>` tag already points at another
   commit, then runs `scripts/verify-release-version.ts`, `bun run prepack`, and
   `npm publish --dry-run --ignore-scripts`, publishes with npm provenance via
   `npm publish --ignore-scripts`, and creates and pushes the annotated
   `v<version>` tag on the checked-out commit. It publishes only from the commit
   that set the version, and only when that commit has no pending changesets that
   release `@lostgradient/weft`. Their YAML frontmatter is parsed as Changesets
   reads it; an empty changeset does not count, and one that cannot be parsed
   blocks the publish.
   This is not left to `changesets/action`, because v2 skips publishing whenever
   changesets are pending, which would strand an already-bumped version.
2. `changesets/action` opens or updates the "Version Packages" pull request when
   changesets are pending. It runs in its own job, beside the publish, without the
   `id-token: write` permission npm's trusted publishing needs. That pull request
   shows the version bump, the changelog entries, and the regenerated
   `src/version.ts`. `scripts/version-pull-request-body.ts` then rewrites the
   action's "publish to npm yourself" sentence: merging that pull request is the
   release, because the push to main runs `release:publish`.
3. The action opens and updates that pull request with `GITHUB_TOKEN`, so GitHub
   holds its `mirror-verify` run for approval, as it does for the Version
   Packages pull requests in Cinder and agent-bureau. Approve the held run from
   the pull request's Checks tab, or with the API, and let `verify` pass before
   merging. Merging is the publication gate, so it stays a human step:

   ```bash
   gh api -X POST repos/stevekinney/weft/actions/runs/<run-id>/approve
   ```

A tag is the result of a release, never the trigger. If a publish succeeded but
the tag push failed, the next run tags the commit npm records as `gitHead`. An
existing tag that points at any other commit fails the run and is never moved.

## Recovery: a superseded bump run

`release:publish` publishes a version npm lacks only from the commit that set it
in `packages/weft/package.json`, meaning HEAD's first parent has a different
version. GitHub can cancel or supersede the run for the Version Packages merge
commit when a later push lands, and the later commit then carries the bumped
version without being the commit that bumped it. In that case the later run
exits non-zero without publishing, and its message names the bump commit:

```bash
git log -1 --format=%H -S'"version": "<version>"' -- packages/weft/package.json
```

Re-run the release workflow run for that commit from the Actions UI (or
`gh run rerun <run-id>`); a re-run uses its original commit, so it publishes
that commit and tags it. The workflow's `queue: max` concurrency keeps pending
runs from being dropped in the first place.

## A Version Packages pull request merged behind newer changes

`main` does not require a pull request to be up to date before it merges, so a
Version Packages pull request can merge after another pull request added a
changeset it never versioned. Its merge commit still has that changeset pending,
and publishing from it would ship the newer change under the older version. The
release run on that merge fails without publishing and names the pending
changesets; later pushes log a warning instead. That version is abandoned, not
recovered: the next Version Packages pull request versions the pending changes
and publishes the version after it, so npm skips one version number.

## Release intent

Release intent is a changeset in `.changeset/`. A change that originates in
corvidae carries its changeset there, and the mirror sync delivers it as
`.changeset/corvidae-<12 hex>-<name>.md`. A change authored in this repository
adds one with `bunx changeset`. Choose the bump (patch, minor, or major) and
write the summary that should reach the changelog. Do not edit
`package.json.version`, `src/version.ts`, or `CHANGELOG.md` by hand;
`bun run changeset:version` (run by the workflow) updates all three together.

## Preparing a release

1. Confirm the changesets on `main` describe what should ship, and check the
   registry and the existing tags:

   ```bash
   ls ../../.changeset
   jq -r '.version' package.json
   npm view @lostgradient/weft version
   git fetch origin main --tags
   git tag --list 'v*' --sort=-version:refname | head -5
   ```

2. Find the open "Version Packages" pull request, or wait for the release run on
   `main` to open it. Review its bump, changelog entries, and `src/version.ts`
   change. Validate its title with the repository helper if you edit it:

   ```bash
   bun run scripts/pr-title.ts validate --title "Version Packages"
   ```

3. If the release adds compiled modules, let `prepack` establish the packed
   entry count before updating `maximumEntryCount` in
   `scripts/check-package-contents.ts`. Keep packed-consumer starts keyed by
   the registered `workflow({ name })` value in
   `scripts/validate-package-consumers.ts`, not the source variable name.

## Local gates

Run the release-specific checks locally when a change touches the release
pipeline or the packed output:

```bash
bun run scripts/verify-release-version.ts
bun run prepack
npm publish --dry-run --ignore-scripts
```

Treat every failing gate as blocking. Do not skip, weaken, retry-count bump, or
timeout-bump a gate to keep the release moving.

## Publication gate

Merging the "Version Packages" pull request is what publishes to npm (the release
run on the merge commit finds a version npm lacks), so that is
where confirmation belongs. Confirm before merging unless the user already
explicitly authorized release publication. Keep monitoring the pull request
until CI is green, review comments are resolved, and the branch has no
conflicts with `origin/main`, then merge it.

Monitor `.github/workflows/release.yaml` on the merge commit until every job is
terminal and green:

```bash
gh run list --workflow release.yaml --limit 5
gh run watch <run-id> --exit-status
npm view @lostgradient/weft version
git ls-remote --tags origin 'v<version>'
```

The release is complete only when the workflow succeeded, npm reports the new
version, and the `v<version>` tag exists on the remote. If the release job fails
before publishing, diagnose it and re-run it; a re-run publishes nothing that is
already on npm. If it fails after publishing, re-run it: the tag is created or
checked against npm's `gitHead`. Delete or move a tag only with explicit user
confirmation.

## Snapshots

A prerelease to the `next` dist-tag is published by dispatching
`release.yaml` with `snapshot: true` and the `expected_sha` the mirror sync
verified. That path is unchanged and does not use changesets.

## Emergency manual publish

Use local `npm publish --ignore-scripts` only when the user explicitly asks for
manual publication and understands it bypasses the normal trusted-publishing
workflow. Before doing that, rerun `bun run prepack`,
`npm publish --dry-run --ignore-scripts`, and
`bun run scripts/verify-release-version.ts`.
