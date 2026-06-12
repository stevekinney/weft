# Task 01: Atomic signal-consume + checkpoint (durability critical path)

**Severity:** critical

## Signal consumed before checkpoint commit — crash loses signal permanently

- **Severity:** critical (durability)
- **Files:** `src/core/engine/operations-coordination.ts`, `src/core/engine/signals.ts`, `src/core/engine/checkpoint-io.ts`

**Evidence:** operations-coordination.ts:97-99 calls consumeSignal (storage.delete on sig: key) then completeOperation, which drives the generator forward to emit a checkpoint. Crash between storage.delete and persistCheckpoint permanently loses the signal. The comment at line 185 explicitly names this as 'the same adjacency the top-level signal path already has' — the top-level path is the unfixed baseline. Also confirmed as the same root cause in timers-retries-signals auditor finding.

**Required fix:** Fold the sig: key delete into the checkpoint batch atomically: accumulate the signal delete as a BatchOperation[] inside processWaitSignalOperation and pass it into createCheckpointCommit's commit.operations, so the write and delete land in one storageConditionalBatch call. Apply the same fix to the bufferedPayload branch at lines 113-119.

## ctx.race/ctx.all signal consume and checkpoint not atomic — tracked as #479, top-level path untracked

- **Severity:** high (durability)
- **Files:** `src/core/engine/operations-coordination.ts`, `src/core/engine/deferred-consume-envelope.ts`, `src/core/engine/coordination-branch-executors.ts`

**Evidence:** operations-coordination.ts:187-190: finalizeFulfilledSlots calls consumeSignal (destructive durable delete) then writePartialEntry only writes to in-memory accumulatedResults. Comment at line 185 acknowledges 'same adjacency'. GitHub issue #479 tracks race/all; top-level processWaitSignalOperation has the identical gap with no tracking issue.

**Required fix:** Same pattern as the top-level fix: accumulate consumeSignal delete operations into a BatchOperation[] that is passed through finalizeFulfilledSlots into the checkpoint commit batch. This closes both #479 and the top-level gap in a single consistent mechanism.
