/**
 * `tryInlineUpdateHandler` captures the update handler before awaiting the
 * durable ownership check. A same-owner signal resume can install a fresh
 * context — with a different handler closure, or none — while that read is in
 * flight, so the captured closure would run against retired workflow-local
 * state.
 *
 * Ownership never changes in this race, so no generation/fencing check catches
 * it; only re-reading the handler after the await does. This mirrors the same
 * post-validation refresh already required of `queries.ts`.
 */
import { describe, expect, it, mock } from 'bun:test';

import { MemoryStorage } from '../../storage/memory.ts';
import { tryInlineUpdateHandler } from './updates.ts';

const WORKFLOW_ID = 'workflow-handler-refresh';
const UPDATE_NAME = 'rename';

function createCallbacks() {
  return {
    dispatchEvent: mock(() => true),
    broadcast: mock(() => {}),
  } as any;
}

describe('inline update dispatch re-reads the handler after the ownership await', () => {
  it('invokes the handler from the context installed after the await, not the captured one', async () => {
    const staleHandler = mock(() => 'stale-value');
    const freshHandler = mock(() => 'fresh-value');

    // `getContext` returns the pre-resume context on the first read and the
    // post-resume context afterwards — standing in for a signal resume landing
    // while the durable holder read is pending.
    let reads = 0;
    const internals = {
      storage: new MemoryStorage(),
      // A registry with a tracked epoch makes `isLiveContextStale` return a
      // promise (so the await genuinely happens) while reporting NOT stale,
      // which is exactly the same-owner case.
      workflowClaimRegistry: { engineId: 'owner-engine', currentEpoch: () => 1 },
      conditionWaiters: new Map(),
      inlineStrategy: {
        getContext: () => {
          reads += 1;
          return {
            updateHandlers: new Map([[UPDATE_NAME, reads === 1 ? staleHandler : freshHandler]]),
          };
        },
      },
    } as any;

    const result = await tryInlineUpdateHandler(
      internals,
      WORKFLOW_ID,
      UPDATE_NAME,
      { value: 1 },
      createCallbacks(),
    );

    expect(result).toEqual({ handled: true, value: 'fresh-value' });
    expect(freshHandler).toHaveBeenCalled();
    // The load-bearing assertion: the superseded closure must never run.
    expect(staleHandler).not.toHaveBeenCalled();
  });

  it('falls through to the coordinated path when the context disappears during the await', async () => {
    // Terminal cleanup or suspend can retire the context mid-read. That must
    // report `'no-handler'` so the durable coordinated path takes over, rather
    // than throwing or invoking a dead closure.
    let reads = 0;
    const internals = {
      storage: new MemoryStorage(),
      workflowClaimRegistry: { engineId: 'owner-engine', currentEpoch: () => 1 },
      conditionWaiters: new Map(),
      inlineStrategy: {
        getContext: () => {
          reads += 1;
          if (reads === 1) {
            return { updateHandlers: new Map([[UPDATE_NAME, mock(() => 'gone')]]) };
          }
          return undefined;
        },
      },
    } as any;

    const result = await tryInlineUpdateHandler(
      internals,
      WORKFLOW_ID,
      UPDATE_NAME,
      { value: 1 },
      createCallbacks(),
    );

    expect(result).toEqual({ handled: false, reason: 'no-handler' });
  });

  it('does not re-read when no claim registry is installed', async () => {
    // `ownership: 'none'`/`'lease'` skip the await entirely, so there is no
    // window to re-read across and no extra `getContext` cost.
    let reads = 0;
    const handler = mock(() => 'plain-value');
    const internals = {
      storage: new MemoryStorage(),
      workflowClaimRegistry: null,
      conditionWaiters: new Map(),
      inlineStrategy: {
        getContext: () => {
          reads += 1;
          return { updateHandlers: new Map([[UPDATE_NAME, handler]]) };
        },
      },
    } as any;

    const result = await tryInlineUpdateHandler(
      internals,
      WORKFLOW_ID,
      UPDATE_NAME,
      { value: 1 },
      createCallbacks(),
    );

    expect(result).toEqual({ handled: true, value: 'plain-value' });
    expect(reads).toBe(1);
  });
});
