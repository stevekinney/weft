# Engine-split log

One file per PR in the `oxlint-strict` engine-split sequence. Each file names:

- The methods extracted from `Engine` to a sibling module
- The `EngineInternals` fields touched
- Any test fixtures regenerated
- The PR's "dependent set" — downstream PRs that build on this one (so a coordinated revert is feasible if needed)

This per-PR log avoids merge conflicts on parallel-safe PRs that would otherwise all append to a single changelog.
