import type { BatchOperation } from '../../../storage/interface.ts';
import type { WorkflowState } from '../../types.ts';

/**
 * Shared function shape for the two workflow-state commit callbacks
 * {@link TerminationCallbacks} exposes, split by ADR 0002's self/
 * external-terminal transition classification (see
 * `documentation/contributing/architecture-decisions/0002-multiengine-per-workflow-ownership.md`).
 * A self-transition (complete, fail) fences on this engine's own claim; an
 * external terminal transition (cancel, timeout, suspend) rotates the claim
 * epoch instead, so any engine may commit it. Kept as one shared type so the
 * two `TerminationCallbacks` fields cannot drift in shape.
 */
export type WorkflowStateCommitCallback = (
  state: WorkflowState,
  operations: BatchOperation[],
  options?: { includePendingAtomicSideEffects?: boolean },
) => Promise<void>;
