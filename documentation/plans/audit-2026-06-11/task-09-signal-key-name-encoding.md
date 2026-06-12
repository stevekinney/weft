# Task 09: Encode signal names in storage keys (colon-aliasing fix)

**Severity:** high

## Finding: Signal storage key embeds unencoded signal name — colon in name causes prefix-scan aliasing and destructive consumeSignal cross-match

- **Severity:** high (durability)
- **Files (audit snapshot):** `src/storage/interface.ts`, `src/core/engine/signals.ts`

### Evidence

interface.ts:439-440: KEYS.signal embeds raw name without encodeStorageKeyComponent. A signal named 'order:placed' produces key sig:<wfid>:order:placed:<encoded_id>. consumeSignal/hasBufferedSignal/peekSignal all build the prefix sig:<wfid>:<rawSignalName>: — a workflow parked on waitForSignal('order') can consume a signal delivered under name 'order:placed' because the prefix matches. consumeSignal destructively deletes the matched key. KEYS.signalAcceptedResponse at line 444-445 correctly encodes name — the inconsistency is an oversight.

### Required fix

Change KEYS.signal at line 440 to use encodeStorageKeyComponent(name) consistent with KEYS.signalAcceptedResponse. Update the three scan-prefix constructions in signals.ts (lines 303, 316, 337) to use encodeStorageKeyComponent(signalName). Add a test verifying that a signal name containing ':' round-trips without key aliasing. This is a storage key format change requiring a schema version note.

## Compatibility requirement

Decide and implement the behavior for pre-existing raw `sig:` keys explicitly: read-side normalization tolerates already-persisted unencoded keys for signal names without separator characters (the only kind that could exist safely), while all fresh writes use the encoded form. Follow the repository's established read-normalization pattern (see the failure-category and versionTuple precedents in CLAUDE.md). Document the encoding in the storage keyspace notes.

## Acceptance criteria (all required — completion is binary)

- [ ] Signal names are encoded in every sig:/sigres: key construction and scan prefix; a signal named `a:b` can no longer match or consume a signal named `a`.
- [ ] Regression tests cover colon-containing, unicode, and empty-edge signal names across deliver, consume, buffered, and scan paths.
- [ ] Pre-existing separator-free persisted keys continue to resolve (read normalization), and the encoding is documented.

## Standard execution requirements

- Line numbers and file paths in the evidence are from the 2026-06-11 audit snapshot and may have drifted. Re-locate every cited site by symbol or function name before editing. If current code differs from the evidence, update the plan to match reality — the invariant being fixed is the requirement, not the line numbers. If the described behavior no longer exists at all, stop and report that instead of forcing a change.
- TDD: every behavioral fix needs a regression test that fails before the fix and passes after. Documentation-only tasks need no new tests but must keep existing doctests green.
- Verification — all of these must pass before the task is complete: `bun run format:check`, `bun run lint`, `bun run typecheck`, `bun test --parallel`. For documentation changes also run `bun run verify:documentation` (plus `bun run verify:markdown-doctests` when Markdown examples change). For changes to exported types or the package surface also run `bun run build` and `bun run verify:jsdoc:full`.
- Completion is binary: every acceptance criterion met and the full suite green. If a criterion cannot be met, stop and report the blocker — do not ship a partial, do not weaken a gate, do not defer silently.
