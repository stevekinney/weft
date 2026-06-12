# Task 28: Export the storage conformance test kit for third-party adapter authors

**Severity:** medium

## Context

`src/storage/storage-adapter.test-support.ts` exports `runStorageCapabilityConformance`, `runBasicStorageContract`, and `runBinaryAndLargeScanStorageConformance`, but line 9 explicitly states they are 'intentionally not re-exported from any package entry point.' No `@lostgradient/weft/storage/testing` subpath exists.

## Evidence

- `src/storage/storage-adapter.test-support.ts:9`: explicit exclusion comment.
- `package.json` exports: the `./testing` subpath exists but its `src/testing/index.ts` exports only TestEngine, chaos helpers, etc. — none of the storage conformance functions.
- `documentation/guides/storage.md`: no 'Implementing a custom adapter' section, no mention of the conformance helpers.
- `documentation/roadmap-to-1.0.md`: notes that Turso needs a conformance proof, which underscores the need for a public-facing conformance suite.

## Proposed Design

1. Add a `@lostgradient/weft/storage/testing` subpath (or extend the existing `./testing` subpath) that exports the three conformance helper functions.
2. Since these functions import `bun:test`, ensure the subpath is excluded from the main bundle (already handled by the build-exclusion mechanism for test-support files).
3. Add a 'Implementing a custom adapter' section to `documentation/guides/storage.md` that links to this suite and shows a minimal usage example.
4. Extend `weft conformance` to optionally cover the storage adapter protocol (analogous to how it covers the RemoteWorker protocol).

## Acceptance Criteria

- A third-party storage adapter author can run the conformance suite by importing from `@lostgradient/weft/storage/testing` without a deep internal import.
- `storage.md` contains a 'Implementing a custom adapter' section that links to the conformance suite.

## Ownership note

This task is the single owner of conformance-surface expansion — the documentation-completeness task explicitly does NOT touch `weft conformance`; cross-reference it rather than duplicating.

## Acceptance criteria (all required — completion is binary)

- [ ] A documented package subpath exposes the storage conformance suite runnable against any StorageAdapter; the packed-consumer check covers the new subpath.
- [ ] documentation/reference/api-storage.md (or a dedicated page) documents how a third-party adapter author runs it; the package surface change passes `bun run prepack` checks.

## Standard execution requirements

- Line numbers and file paths in the evidence are from the 2026-06-11 audit snapshot and may have drifted. Re-locate every cited site by symbol or function name before editing. If current code differs from the evidence, update the plan to match reality — the invariant being fixed is the requirement, not the line numbers. If the described behavior no longer exists at all, stop and report that instead of forcing a change.
- TDD: every behavioral fix needs a regression test that fails before the fix and passes after. Documentation-only tasks need no new tests but must keep existing doctests green.
- Verification — all of these must pass before the task is complete: `bun run format:check`, `bun run lint`, `bun run typecheck`, `bun test --parallel`. For documentation changes also run `bun run verify:documentation` (plus `bun run verify:markdown-doctests` when Markdown examples change). For changes to exported types or the package surface also run `bun run build` and `bun run verify:jsdoc:full`.
- Completion is binary: every acceptance criterion met and the full suite green. If a criterion cannot be met, stop and report the blocker — do not ship a partial, do not weaken a gate, do not defer silently.
