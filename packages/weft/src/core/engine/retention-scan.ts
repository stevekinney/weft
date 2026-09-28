import { KEYS, tryDecodeStorageKeyComponent } from '../../storage/interface.ts';
import type { NormalizedRetentionPolicy, WorkflowState } from '../types.ts';
import { EngineDisposedError } from './errors.ts';
import type { EngineInternals } from './internals.ts';
import { markPurgeWriteFailures, trackPurgeWrite } from './purge-write-tracking.ts';
import {
  forEachResolvedDynamicRetentionPolicy,
  hasUnresolvedDynamicSourceCandidate,
} from './registration.ts';
import { decodeWorkflowState, isTerminalWorkflowStatus } from './validation.ts';

function getMinimumRetentionMs(internals: EngineInternals): number | null {
  let minimumRetentionMs: number | null = null;

  const considerRetentionPolicy = (policy: NormalizedRetentionPolicy | null | undefined): void => {
    for (const retentionMs of [
      policy?.completed,
      policy?.failed,
      policy?.cancelled,
      policy?.timedOut,
    ]) {
      if (retentionMs === undefined) continue;

      minimumRetentionMs =
        minimumRetentionMs === null ? retentionMs : Math.min(minimumRetentionMs, retentionMs);
    }
  };

  considerRetentionPolicy(internals.options.retention);
  for (const registration of internals.registrations.values()) {
    considerRetentionPolicy(registration.retention);
  }
  forEachResolvedDynamicRetentionPolicy(internals, considerRetentionPolicy);

  return minimumRetentionMs;
}

export async function* streamExpiredRetentionWorkflowStates(
  internals: EngineInternals,
  now: number,
): AsyncGenerator<WorkflowState> {
  // A registered-but-unresolved dynamic-source candidate's retention policy
  // is unknown, so the minimum-retention scan bound below cannot be
  // trusted while one exists (WFT-19 review round 1) — fall back to an
  // unbounded terminal scan, letting `shouldPurgeWorkflowState`'s own
  // per-run async resolve decide each state; self-heals once the sweep's
  // own resolve installs the candidate and the fast bound re-engages.
  const untrustworthyBound = hasUnresolvedDynamicSourceCandidate(internals);
  const minimumRetentionMs = untrustworthyBound ? null : getMinimumRetentionMs(internals);
  if (!untrustworthyBound && minimumRetentionMs === null) return;

  const terminalWorkflowPrefix = KEYS.terminalWorkflowPrefix();
  const scanOptions =
    minimumRetentionMs === null
      ? {}
      : {
          lte: `${terminalWorkflowPrefix}${String(now - minimumRetentionMs).padStart(16, '0')}:\xff`,
        };

  for await (const [key] of internals.storage.scan(terminalWorkflowPrefix, scanOptions)) {
    const encodedWorkflowId = key.slice(key.lastIndexOf(':') + 1);
    const workflowId = tryDecodeStorageKeyComponent(encodedWorkflowId);
    if (workflowId === null) continue;

    const stateBytes = await internals.storage.get(KEYS.workflow(workflowId));
    // Disposal does not cancel a sweep already in flight, so a scan that
    // outlives its engine stops here, before deleting an orphaned index entry
    // or handing another candidate to the purge loop.
    if (internals.disposed) throw new EngineDisposedError();
    if (!stateBytes) {
      await markPurgeWriteFailures(trackPurgeWrite(internals, internals.storage.delete(key)));
      continue;
    }

    const state = decodeWorkflowState(stateBytes);
    if (!isTerminalWorkflowStatus(state.status)) continue;

    yield state;
  }
}
