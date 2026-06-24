---
name: release-publish
description: >-
  Use this skill when cutting, preparing, validating, tagging, publishing, or
  troubleshooting a Weft npm release for @lostgradient/weft.
---

# Release Publish

## Release contract

Publish Weft through the GitHub Actions release workflow, not by defaulting to a
local `npm publish`. The workflow triggers from a pushed `vX.Y.Z` tag, verifies
that the tag, `package.json.version`, and `src/version.ts` agree, runs
`bun run validate`, runs `bun run prepack`, performs
`npm publish --dry-run --ignore-scripts`, and publishes with npm provenance via
`npm publish --ignore-scripts`.

## Preparation

1. Confirm the target SemVer version. If the user did not provide it, inspect
   the current package and npm state before choosing:

   ```bash
   jq -r '.version' package.json
   npm view @lostgradient/weft version
   git fetch origin main --tags
   git tag --list 'v*' --sort=-version:refname | head -5
   ```

2. Work from a clean branch based on current `origin/main`. Do not release from
   a detached head, dirty checkout, stale base, or unmerged pull request branch.

   ```bash
   git status --short --branch
   git fetch origin main --tags
   git switch -c steve/release-vX.Y.Z origin/main
   ```

3. Update every shipped version surface together:
   - `package.json` `version`
   - `src/version.ts` `VERSION`
   - `README.md` current release line

4. Search for the old version and update only release-version references that
   are meant to track the current package version:

   ```bash
   rg '0\.0\.0|X\.Y\.Z|Current release|VERSION' README.md documentation src package.json
   ```

## Local gates

Run the release-specific checks before opening the release pull request:

```bash
bun run scripts/verify-release-version.ts --tag=vX.Y.Z
bun run validate
bun run prepack
npm publish --dry-run --ignore-scripts
```

Treat every failing gate as blocking. Do not skip, weaken, retry-count bump, or
timeout-bump a gate to keep the release moving.

## Pull request

Open a normal pull request, not a draft, after the local gates pass. Validate the
title with the repository title helper:

```bash
draft_title="Release vX.Y.Z"
normalized_title=$(bun run scripts/pr-title.ts normalize --title "$draft_title" | jq -r '.normalizedTitle // empty')
pull_request_title="${normalized_title:-$draft_title}"
bun run scripts/pr-title.ts validate --title "$pull_request_title"
```

The pull request body must list the target version and the exact release gates
that passed. Keep monitoring until CI is green, review comments are resolved, and
the branch has no conflicts with `origin/main`.

## Tag and publish

After the release pull request is merged, fetch the merged commit and create the
release tag from current `origin/main`:

```bash
git fetch origin main --tags
git switch main
git pull --ff-only origin main
bun run scripts/verify-release-version.ts --tag=vX.Y.Z
git tag vX.Y.Z
git show --stat vX.Y.Z
```

Pushing the tag starts the real npm publish. Confirm before pushing the tag
unless the user already explicitly authorized release publication:

```bash
git push origin vX.Y.Z
```

Monitor `.github/workflows/release.yaml` until every job is terminal and green:

```bash
gh run list --workflow release.yaml --limit 5
gh run watch <run-id> --exit-status
npm view @lostgradient/weft version
```

The release is complete only when the workflow succeeded and npm reports the new
version. If the tag workflow fails, diagnose the failing job, fix the repository
state through a pull request when code changes are needed, delete or move the tag
only with explicit user confirmation, and re-run the release from a clean tag.

## Emergency manual publish

Use local `npm publish --ignore-scripts` only when the user explicitly asks for
manual publication and understands it bypasses the normal trusted-publishing
workflow. Before doing that, rerun `bun run prepack`,
`npm publish --dry-run --ignore-scripts`, and
`bun run scripts/verify-release-version.ts --tag=vX.Y.Z`.
