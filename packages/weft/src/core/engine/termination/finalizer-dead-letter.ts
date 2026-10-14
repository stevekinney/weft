/**
 * Dead-letter paths that never run the finalizer: the recorded resource state is gone, or
 * every attempt was spent by a crashed host (COR-1422). Split from `./finalizer.ts` to keep
 * that module under the size budget.
 *
 * @module core/engine/termination/finalizer-dead-letter
 */

import { WorkflowTeardownEvent } from '../../events.ts';
import type { WorkflowState } from '../../types.ts';
import type { EngineInternals } from '../internals.ts';
import type { TeardownClaim } from '../state-utilities.ts';
import { deadLetterTeardown, MAX_TEARDOWN_ATTEMPTS, type TeardownHold } from './finalizer-claim.ts';

/**
 * The attempts a claim has already spent (COR-1422): a settled `owed` claim carries its count;
 * a `running` claim that reaches a drive was abandoned mid-attempt, so that attempt counts too.
 * Clamped to `MAX_TEARDOWN_ATTEMPTS` so a corrupt near-`MAX_SAFE_INTEGER` count can
 * neither overflow into an unsafe integer nor produce a dead-letter record the status reader
 * rejects.
 */
export function spentTeardownAttempts(claim: TeardownClaim): number {
  const spent = claim.status === 'running' ? claim.attempts + 1 : claim.attempts;
  return Math.min(spent, MAX_TEARDOWN_ATTEMPTS);
}

type FinalizerDriveCallbacks = { dispatchEvent: (event: Event) => void };

/**
 * Dead-letter a teardown without running the finalizer: its recorded state is gone, or its
 * attempts were all consumed by crashes. Conditioned on `expected` so a concurrent settle is
 * never overwritten; the event is emitted only after the durable record commits.
 */
export async function deadLetterWithoutRunning(
  internals: EngineInternals,
  workflowId: string,
  state: WorkflowState,
  attempts: number,
  expected: TeardownHold,
  lastError: string,
  finalizerInput: unknown,
  callbacks: FinalizerDriveCallbacks,
): Promise<void> {
  const settled = await deadLetterTeardown(
    internals,
    workflowId,
    state.type,
    attempts,
    expected,
    { lastError, finalizerInput },
    state.workflowExecutionToken,
    state.revision,
  );
  if (settled) {
    // The event's `error` is present for every 'failed'/'dead-lettered' status (the
    // documented contract). Carry the same reason the dead-letter record stores so the
    // event stream is consistent with the attempt-exhausted dead-letter path.
    callbacks.dispatchEvent(
      new WorkflowTeardownEvent(workflowId, state.type, 'dead-lettered', attempts, lastError),
    );
  }
}
