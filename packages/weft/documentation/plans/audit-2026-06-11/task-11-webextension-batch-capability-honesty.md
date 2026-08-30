# Task 11: WebExtensionStorage: report batch capability honestly

**Severity:** high

## Finding: WebExtensionStorage claims atomicBatch: true but batch() is only in-process-serialized, not cross-context atomic

- **Severity:** high (durability)
- **Files (audit snapshot):** `src/storage/web-extension.ts`

### Evidence

web-extension.ts:280: capabilities() returns atomicBatch: true. The #withMutationLock at lines 327-346 is a process-local Promise queue — two extension contexts (background + content script) sharing chrome.storage.local both call #getKeyspace(), apply edits in memory, then call #writeKeyspace(), silently overwriting each other. browser.storage.set() is not a transaction. The inline comment at lines 273-275 even acknowledges 'no native CAS and scans are best-effort across extension contexts' yet still returns atomicBatch: true.

### Required fix

Downgrade atomicBatch to false in WebExtensionStorage.capabilities(). Update the storage.md table to show atomicBatch as 'no (same context only)' for WebExtensionStorage, and add a prominent warning in the adapter section that multi-context deployments cannot rely on atomic batch semantics.

## Scope clarification

The required change is capability honesty, not a rewrite of the adapter: report the actual guarantee, and verify what `assertDurableStorageForRecovery()` then concludes. The WebExtension adapter is an experimental browser surface — if honest capabilities exclude it from durable-recovery claims, that is the correct outcome and the docs must say so.

## Acceptance criteria (all required — completion is binary)

- [ ] capabilities() reflects what batch() actually guarantees cross-context; any test asserting the old claim is corrected rather than deleted.
- [ ] assertDurableStorageForRecovery() behavior against the adapter is pinned by a test, and the storage guide documents the consequence.

## Standard execution requirements

- Line numbers and file paths in the evidence are from the 2026-06-11 audit snapshot and may have drifted. Re-locate every cited site by symbol or function name before editing. If current code differs from the evidence, update the plan to match reality — the invariant being fixed is the requirement, not the line numbers. If the described behavior no longer exists at all, stop and report that instead of forcing a change.
- TDD: every behavioral fix needs a regression test that fails before the fix and passes after. Documentation-only tasks need no new tests but must keep existing doctests green.
- Verification — all of these must pass before the task is complete: `bun run format:check`, `bun run lint`, `bun run typecheck`, `bun test --parallel`. For documentation changes also run `bun run verify:documentation` (plus `bun run verify:markdown-doctests` when Markdown examples change). For changes to exported types or the package surface also run `bun run build` and `bun run verify:jsdoc:full`.
- Completion is binary: every acceptance criterion met and the full suite green. If a criterion cannot be met, stop and report the blocker — do not ship a partial, do not weaken a gate, do not defer silently.
