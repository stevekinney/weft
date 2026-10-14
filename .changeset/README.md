# Changesets

This folder is managed by [Changesets](https://github.com/changesets/changesets). It drives releases of `@lostgradient/weft`.

## Add a changeset

When a pull request changes `@lostgradient/weft` in a way that should ship, add a changeset:

```bash
bunx changeset
```

Pick the bump type (patch, minor, or major) and write a short summary. Commit the generated markdown file with the pull request.

Changes that arrive from the corvidae mirror sync carry their own changesets: corvidae writes them next to the change, and the sync delivers them here as `corvidae-<12 hex>-<name>.md`.

## What happens next

Merging to `main` runs the release workflow. Each run first publishes any version npm does not have yet, then, when changesets are pending, opens or updates a "Version Packages" pull request that applies the bumps, regenerates `src/version.ts`, and updates `packages/weft/CHANGELOG.md`. Merging that pull request makes the next release run find an unpublished version, which it publishes to npm with provenance through trusted publishing and tags `v<version>`.

A push to `main` that changes no version publishes nothing: the publish step asks npm whether the version already exists and skips it when it does.
