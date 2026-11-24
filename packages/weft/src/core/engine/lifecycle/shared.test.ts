import { describe, expect, it, mock } from 'bun:test';

import { MemoryStorage } from "../../../embedded/storage/src/index.ts";
import type { EngineInternals } from '../internals.ts';
import { enforceHistoryPolicyBeforeReplayById } from './shared.ts';

function createInternals(maxEvents: number | null, cachedHeadSequence?: number): EngineInternals {
  return {
    options: { historyPolicy: { maxEvents } },
    eventLogHeads: new Map(
      cachedHeadSequence === undefined ? [] : [['run', { sequence: cachedHeadSequence }]],
    ),
    storage: new MemoryStorage(),
  } as unknown as EngineInternals;
}

describe('enforceHistoryPolicyBeforeReplayById', () => {
  it('does nothing when the history circuit breaker is off', async () => {
    const enforceHistoryCircuitBreaker = mock(async () => {});

    expect(
      await enforceHistoryPolicyBeforeReplayById(createInternals(null), 'run', {
        enforceHistoryCircuitBreaker,
      }),
    ).toBe(false);
    expect(enforceHistoryCircuitBreaker).not.toHaveBeenCalled();
  });

  it('trips the breaker from the head the engine already tracks', async () => {
    const enforceHistoryCircuitBreaker = mock(async () => {});

    expect(
      await enforceHistoryPolicyBeforeReplayById(createInternals(2, 2), 'run', {
        enforceHistoryCircuitBreaker,
      }),
    ).toBe(true);
    expect(enforceHistoryCircuitBreaker).toHaveBeenCalledWith('run');
  });

  it('reads the head from storage for a workflow the engine does not track', async () => {
    const enforceHistoryCircuitBreaker = mock(async () => {});

    // The store holds no event log for the run, so its head is before the first event.
    expect(
      await enforceHistoryPolicyBeforeReplayById(createInternals(2), 'run', {
        enforceHistoryCircuitBreaker,
      }),
    ).toBe(false);
    expect(enforceHistoryCircuitBreaker).not.toHaveBeenCalled();
  });
});
