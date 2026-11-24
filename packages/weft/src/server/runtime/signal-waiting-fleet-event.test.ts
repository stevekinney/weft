/**
 * COR-1472: `signal:waiting` reaches `serve()`'s fleet feed through
 * `appendWorkflowEventIfPresent`, and the per-workflow watch copy written
 * alongside it no longer lands in the engine's event log.
 *
 * Before the fix the watch copies were stored at `ev:<workflowId>:<sequence>`,
 * the hash-chained event log's own keys, so each one replaced the log record at
 * the same sequence. A `signal:waiting` written while a workflow was parked
 * replaced the checkpoint record that carries the replay payload, and a
 * recovery after a crash re-ran the activity that checkpoint had recorded.
 */
import { describe, expect, it } from 'bun:test';

import { MemoryStorage } from "../../embedded/storage/src/index.ts";
import { decode } from '../../core/codec.ts';
import { Engine } from '../../core/engine.ts';
import { nextSignalWaiting } from '../../core/engine/signal-wait-tracking.test-support.ts';
import { verifyEventLog } from '../../core/event-log-verify.ts';
import { activity, workflow, type WorkflowContext } from '../../core/types.ts';
import { KEYS } from '../../storage/keys.ts';
import {
  createFleetEventFeed,
  type FleetEventEnvelope,
  type FleetEventFeed,
} from '../fleet-event-feed.ts';
import { wireEventBroadcasting } from './event-broadcasting.ts';

let activityRuns = 0;
const countedActivity = activity({
  name: 'counted-activity',
  execute: async () => {
    activityRuns += 1;
    return activityRuns;
  },
});

const activityThenApproval = workflow({ name: 'activity-then-approval' }).execute(async function* (
  ctx: WorkflowContext,
) {
  const activityRun = yield* ctx.run('counted-activity');
  const approval = yield* ctx.waitForSignal<string>('approval');
  return { activityRun, approval };
});

function createEngine(storage: MemoryStorage): Engine {
  const engine = new Engine({ storage });
  engine.register(countedActivity);
  engine.register(activityThenApproval);
  return engine;
}

/** Resolve with the envelope the feed appends for the next `kind` event of `workflowId`. */
function nextWorkflowAppend(
  feed: FleetEventFeed,
  workflowId: string,
  kind: string,
): Promise<FleetEventEnvelope | null> {
  const appended = Promise.withResolvers<FleetEventEnvelope | null>();
  const append = feed.appendWorkflowEventIfPresent.bind(feed);
  feed.appendWorkflowEventIfPresent = async (event) => {
    const envelope = await append(event);
    if (event.workflowId === workflowId && event.kind === kind) appended.resolve(envelope);
    return envelope;
  };
  return appended.promise;
}

async function watchEventKinds(storage: MemoryStorage, workflowId: string): Promise<string[]> {
  const kinds: string[] = [];
  for await (const [, value] of storage.scan(KEYS.watchEventPrefix(workflowId))) {
    kinds.push((decode(value) as { type: string }).type);
  }
  return kinds;
}

describe('signal:waiting on the fleet feed', () => {
  it('is appended through appendWorkflowEventIfPresent and reads back for its workflow', async () => {
    const storage = new MemoryStorage();
    await using engine = createEngine(storage);
    const feed = createFleetEventFeed(storage);
    const appended = nextWorkflowAppend(feed, 'fleet-waiting-1', 'signal:waiting');
    const broadcasting = wireEventBroadcasting(engine, { publish() {} } as never, {
      fleetEventFeed: feed,
    });

    await engine.start('activity-then-approval', null, { id: 'fleet-waiting-1' });
    const envelope = await appended;

    const replayed: FleetEventEnvelope[] = [];
    for await (const event of feed.replay({ workflowId: 'fleet-waiting-1' })) replayed.push(event);
    broadcasting.dispose();
    feed.dispose();

    expect(envelope).not.toBeNull();
    const waiting = replayed.filter((event) => event.kind === 'signal:waiting');
    expect(waiting).toHaveLength(1);
    expect(waiting[0]).toMatchObject({
      workflowId: 'fleet-waiting-1',
      payload: { workflowId: 'fleet-waiting-1', signalName: 'approval' },
    });
  });
});

describe('watch copies of workflow events', () => {
  it('leave the event log intact, so a recovery does not re-run a recorded activity', async () => {
    activityRuns = 0;
    const storage = new MemoryStorage();
    const workflowId = 'watch-keyspace-1';

    using first = createEngine(storage);
    const firstFeed = createFleetEventFeed(storage);
    const parked = nextWorkflowAppend(firstFeed, workflowId, 'signal:waiting');
    const firstBroadcasting = wireEventBroadcasting(first, { publish() {} } as never, {
      fleetEventFeed: firstFeed,
    });
    const listed = nextSignalWaiting(first, workflowId, 'approval');
    await first.start('activity-then-approval', null, { id: workflowId });
    await listed;
    await parked;

    expect(await verifyEventLog(storage, workflowId)).toEqual({ valid: true });
    expect(await watchEventKinds(storage, workflowId)).toEqual([
      'workflow:started',
      'activity:started',
      'activity:completed',
      'signal:waiting',
    ]);
    firstBroadcasting.dispose();
    firstFeed.dispose();
    first[Symbol.dispose]();

    await using second = createEngine(storage);
    const secondFeed = createFleetEventFeed(storage);
    const completed = nextWorkflowAppend(secondFeed, workflowId, 'workflow:completed');
    const secondBroadcasting = wireEventBroadcasting(second, { publish() {} } as never, {
      fleetEventFeed: secondFeed,
    });
    const [recovered] = await second.recoverAll();
    if (recovered === undefined) throw new Error('expected the parked run to be recovered');
    await second.signal(workflowId, 'approval', 'yes');

    expect(await recovered.result()).toEqual({ activityRun: 1, approval: 'yes' });
    expect(activityRuns).toBe(1);
    await completed;
    secondBroadcasting.dispose();
    secondFeed.dispose();

    const kinds = await watchEventKinds(storage, workflowId);
    expect(kinds.slice(0, 4)).toEqual([
      'workflow:started',
      'activity:started',
      'activity:completed',
      'signal:waiting',
    ]);
    expect(kinds).toContain('signal:received');
    expect(kinds.at(-1)).toBe('workflow:completed');
    expect(await verifyEventLog(storage, workflowId)).toEqual({ valid: true });
  });
});
