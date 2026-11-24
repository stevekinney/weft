/**
 * COR-1604: the `waitingForSignals` bookkeeping is fenced to the run a wait
 * started under, never to whatever run holds the workflow id when the write
 * lands.
 *
 * Every interleaving is forced with promise gates on storage calls, never with
 * timers: a cancel, a `start-new` replacement, and the replacement's own park
 * all land while the original run's wait is suspended inside one storage read.
 */
import { describe, expect, it } from 'bun:test';

import { MemoryStorage, type ScanOptions } from "../../embedded/storage/src/index.ts";
import { KEYS } from '../../storage/keys.ts';
import { encode } from '../codec.ts';
import { workflow, type WorkflowContext } from '../types.ts';
import { adoptLaunchCheckpoint } from './checkpoint-commit-snapshots.ts';
import { Engine } from './index.ts';
import { getInternals } from './internals.ts';
import {
  nextSignalWaiting,
  recordSignalWaitingEvents,
  settleWorkflowStateWrites,
  waitingForSignalsOf,
} from './signal-wait-tracking.test-support.ts';
import {
  captureSignalWaitRun,
  clearSignalWait,
  recordSignalWaitBegan,
} from './signal-wait-tracking.ts';
import { decodeWorkflowState } from './validation.ts';

/** Parks on the signal its input names, so a replacement can wait on a different one. */
const waitForNamedSignal = workflow({ name: 'cor-1604-wait-for-named-signal' }).execute(
  async function* (ctx: WorkflowContext, input: { signal: string }) {
    return yield* ctx.waitForSignal<string>(input.signal);
  },
);

function createEngine(storage: MemoryStorage): Engine {
  const engine = new Engine({ storage });
  engine.register(waitForNamedSignal);
  return engine;
}

/** Resolve on the next read of `workflowId`'s `wf:` record. */
function nextWorkflowRecordRead(storage: MemoryStorage, workflowId: string): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  const get = storage.get.bind(storage);
  storage.get = async (key: string) => {
    if (key === KEYS.workflow(workflowId)) {
      storage.get = get;
      resolve();
    }
    return await get(key);
  };
  return promise;
}

/** Rewrite `workflowId`'s record directly, as another engine's write would. */
async function rewriteWorkflowRecord(
  storage: MemoryStorage,
  workflowId: string,
  change: (state: ReturnType<typeof decodeWorkflowState>) => object,
): Promise<void> {
  const bytes = await storage.get(KEYS.workflow(workflowId));
  if (bytes === null) throw new Error(`expected a record for ${workflowId}`);
  await storage.put(KEYS.workflow(workflowId), encode(change(decodeWorkflowState(bytes))));
}

describe('an inline park whose run is replaced inside its second buffered-signal read', () => {
  it("leaves the replacement's waitingForSignals holding only its own wait", async () => {
    const id = 'cor-1604-inline-park';
    const storage = new MemoryStorage();
    await using engine = createEngine(storage);
    const internals = getInternals(engine);

    // Hold the old run's buffered-signal read that runs once its parked marker is
    // published: the one between the park and the wait's durable listing.
    const secondReadReached = Promise.withResolvers<void>();
    const releaseSecondRead = Promise.withResolvers<void>();
    const scan = storage.scan.bind(storage);
    storage.scan = async function* (prefix: string, options?: ScanOptions) {
      if (prefix.endsWith(':old:') && internals.parkedInlineWorkflows.has(id)) {
        secondReadReached.resolve();
        await releaseSecondRead.promise;
      }
      yield* scan(prefix, options);
    };

    const original = await engine.start(waitForNamedSignal.name, { signal: 'old' }, { id });
    const originalSettled = original.result().catch((error: unknown) => error);
    await secondReadReached.promise;

    // Cancel, start the replacement under the same id, and let it park and list
    // its own wait, all while the original run's read is still outstanding.
    await engine.cancel(id);
    await originalSettled;
    const replacementWaiting = nextSignalWaiting(engine, id, 'new');
    await engine.start(
      waitForNamedSignal.name,
      { signal: 'new' },
      { id, onTerminalConflict: 'start-new' },
    );
    await replacementWaiting;
    expect(await waitingForSignalsOf(engine, id)).toEqual(['new']);

    const events = recordSignalWaitingEvents(engine);
    const staleWriteRead = nextWorkflowRecordRead(storage, id);
    releaseSecondRead.resolve();
    await staleWriteRead;
    await settleWorkflowStateWrites(engine, id);

    expect(await waitingForSignalsOf(engine, id)).toEqual(['new']);
    expect(events).toEqual([]);
  });
});

describe('a wait from a run with no in-memory execution token', () => {
  it('still lists and clears its own wait when the engine holds no checkpoint for the run', async () => {
    const id = 'cor-1604-no-checkpoint';
    const storage = new MemoryStorage();
    await using engine = createEngine(storage);
    const internals = getInternals(engine);
    await engine.start(waitForNamedSignal.name, { signal: 'approval' }, { id });
    await nextSignalWaiting(engine, id, 'approval');

    // The engine still holds the run, recovered from its persisted record, but
    // keeps no checkpoint and so no in-memory token for it.
    const run = captureSignalWaitRun(internals, id);
    expect(run?.workflowExecutionToken).toBeString();
    internals.checkpoints.delete(id);
    internals.durableInlineOperations.delete(id);

    await clearSignalWait(internals, id, run, 'approval');
    expect(await waitingForSignalsOf(engine, id)).toBeUndefined();
    await recordSignalWaitBegan(internals, id, run, 'approval', () => true);
    expect(await waitingForSignalsOf(engine, id)).toEqual(['approval']);
  });

  it('writes for a pre-token run and drops the write once a token-bearing replacement holds the record', async () => {
    const id = 'cor-1604-pre-token';
    const storage = new MemoryStorage();
    await using engine = createEngine(storage);
    const internals = getInternals(engine);
    await engine.start(waitForNamedSignal.name, { signal: 'approval' }, { id });
    await nextSignalWaiting(engine, id, 'approval');

    // Turn the run into one recovered from before execution tokens existed: no
    // token on its record, its checkpoint, or the attempt that launched it.
    await rewriteWorkflowRecord(storage, id, (state) => {
      const { workflowExecutionToken: _token, ...legacy } = state;
      return legacy;
    });
    const legacyCheckpoint = { ...internals.checkpoints.get(id)! };
    delete legacyCheckpoint.workflowExecutionToken;
    adoptLaunchCheckpoint(internals, id, legacyCheckpoint);
    internals.durableInlineOperations.delete(id);
    const run = captureSignalWaitRun(internals, id);
    expect(run?.workflowExecutionToken).toBeUndefined();

    await recordSignalWaitBegan(internals, id, run, 'second', () => true);
    expect(await waitingForSignalsOf(engine, id)).toEqual(['approval', 'second']);

    // Another engine cancels the run and installs a token-bearing `start-new`
    // replacement between this write's read and its commit. The retry reloads
    // the replacement, which is not the run the wait started under.
    const conditionalBatch = storage.conditionalBatch.bind(storage);
    let replaced = false;
    storage.conditionalBatch = async (conditions, operations) => {
      if (!replaced) {
        replaced = true;
        await rewriteWorkflowRecord(storage, id, (state) => ({
          ...state,
          workflowExecutionToken: 'replacement-run',
          waitingForSignals: ['replacement-wait'],
        }));
      }
      return await conditionalBatch(conditions, operations);
    };

    await clearSignalWait(internals, id, run, 'approval');
    expect(replaced).toBe(true);
    expect(await waitingForSignalsOf(engine, id)).toEqual(['replacement-wait']);
    await recordSignalWaitBegan(internals, id, run, 'stale', () => true);
    await clearSignalWait(internals, id, run, 'replacement-wait');
    expect(await waitingForSignalsOf(engine, id)).toEqual(['replacement-wait']);
  });
});
