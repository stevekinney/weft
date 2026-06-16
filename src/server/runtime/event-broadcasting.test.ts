import { describe, expect, it } from 'bun:test';

import { decode, encode } from '../../core/codec.ts';
import { Engine } from '../../core/engine.ts';
import {
  ActivityAsyncPendingEvent,
  AlertFiredEvent,
  ConstraintViolatedEvent,
  ScheduleFiredEvent,
  ScheduleMissedFireEvent,
  TaskResultDeadLetteredEvent,
  WorkerConnectedEvent,
  WorkerDisconnectedEvent,
  WorkflowResumedEvent,
  WorkflowSuspendedEvent,
  WorkflowTeardownEvent,
} from '../../core/events.ts';
import { waitForParityCondition as waitFor } from '../../core/parity/real-timer-wait.test-support.ts';
import { ReviewCompletedEvent, ReviewRequestedEvent } from '../../core/review/events.ts';
import { KEYS } from '../../storage/interface.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { createFleetEventFeed, type FleetEventEnvelope } from '../fleet-event-feed.ts';
import { CLIENT_VISIBLE_EVENT_TYPES, TOKEN_EVENT_TYPE } from './client-visible-events.ts';
import { wireEventBroadcasting } from './event-broadcasting.ts';

class TokenEvent extends Event {
  constructor(
    public readonly workflowId: string,
    public readonly token: string,
    public readonly model: string,
  ) {
    super(TOKEN_EVENT_TYPE);
  }
}

describe('wireEventBroadcasting', () => {
  it('keeps operational runtime events in the client-visible broadcast set', () => {
    expect(CLIENT_VISIBLE_EVENT_TYPES).toEqual(
      expect.arrayContaining([
        ActivityAsyncPendingEvent.type,
        TaskResultDeadLetteredEvent.type,
        ScheduleFiredEvent.type,
        ScheduleMissedFireEvent.type,
        ReviewRequestedEvent.type,
        ReviewCompletedEvent.type,
        AlertFiredEvent.type,
        ConstraintViolatedEvent.type,
        WorkflowResumedEvent.type,
        WorkflowSuspendedEvent.type,
        WorkflowTeardownEvent.type,
        WorkerConnectedEvent.type,
        WorkerDisconnectedEvent.type,
      ]),
    );
  });

  it('publishes no-workflow operational events through the fleet feed', async () => {
    const engine = new Engine({ storage: new MemoryStorage() });
    const fleetEventFeed = createFleetEventFeed(engine.storage);
    const handle = wireEventBroadcasting(engine, { publish() {} } as never, { fleetEventFeed });

    engine.dispatchEvent(new AlertFiredEvent('queue-depth', 10, 11));

    await waitFor(
      async () => {
        for await (const _envelope of fleetEventFeed.replay()) return true;
        return false;
      },
      { label: 'fleet alert event persisted' },
    );
    const events: FleetEventEnvelope[] = [];
    for await (const envelope of fleetEventFeed.replay()) events.push(envelope);
    handle.dispose();
    engine[Symbol.dispose]();

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: AlertFiredEvent.type,
      payload: { metric: 'queue-depth', threshold: 10, currentValue: 11 },
    });
  });

  it('keeps token stream payloads out of events-read feeds and watch storage', async () => {
    const engine = new Engine({ storage: new MemoryStorage() });
    const fleetEventFeed = createFleetEventFeed(engine.storage);
    const handle = wireEventBroadcasting(engine, { publish() {} } as never, { fleetEventFeed });

    engine.dispatchEvent(new TokenEvent('wf-token', 'secret-token', 'gpt-4'));

    await waitFor(
      async () => (await engine.storage.get(KEYS.streamTail('wf-token', 'tokens'))) !== null,
      { label: 'token stream chunk persisted' },
    );

    const fleetEvents: FleetEventEnvelope[] = [];
    for await (const envelope of fleetEventFeed.replay()) fleetEvents.push(envelope);
    const storedWatchEvent = await engine.storage.get(KEYS.event('wf-token', 0));
    handle.dispose();
    engine[Symbol.dispose]();

    expect(fleetEvents).toEqual([]);
    expect(storedWatchEvent).toBeNull();
  });

  it('continues token stream sequencing from a stored tail marker', async () => {
    const engine = new Engine({ storage: new MemoryStorage() });
    await engine.storage.put(KEYS.streamTail('wf-tail', 'tokens'), encode({ sequence: 6 }));
    const published: Array<{ workflowId: string; sequence: number; message: string }> = [];
    const handle = wireEventBroadcasting(engine, { publish() {} } as never, {
      publishTokenMessage(workflowId, sequence, message) {
        published.push({ workflowId, sequence, message });
      },
    });

    engine.dispatchEvent(new TokenEvent('wf-tail', 'tail-token', 'gpt-4'));

    await waitFor(async () => published.length === 1, { label: 'token stream published' });
    const tail = decode((await engine.storage.get(KEYS.streamTail('wf-tail', 'tokens')))!);
    handle.dispose();
    engine[Symbol.dispose]();

    expect(published[0]).toMatchObject({ workflowId: 'wf-tail', sequence: 7 });
    expect(tail).toEqual({ sequence: 7 });
  });

  it('continues token stream sequencing from existing chunk keys when no tail marker exists', async () => {
    const engine = new Engine({ storage: new MemoryStorage() });
    await engine.storage.put(KEYS.streamChunk('wf-chunk', 'tokens', 4), encode({ token: 'old' }));
    const published: Array<{ sequence: number; message: string }> = [];
    const handle = wireEventBroadcasting(engine, { publish() {} } as never, {
      publishTokenMessage(_workflowId, sequence, message) {
        published.push({ sequence, message });
      },
    });

    engine.dispatchEvent(new TokenEvent('wf-chunk', 'chunk-token', 'gpt-4'));

    await waitFor(async () => published.length === 1, { label: 'token stream published' });
    handle.dispose();
    engine[Symbol.dispose]();

    expect(published[0]!.sequence).toBe(5);
  });

  it('publishes watch events through the server channel when no direct watch publisher is supplied', async () => {
    const engine = new Engine({ storage: new MemoryStorage() });
    const published: Array<{ channel: string; message: string }> = [];
    const handle = wireEventBroadcasting(engine, {
      publish(channel: string, message: string) {
        published.push({ channel, message });
      },
    } as never);

    engine.dispatchEvent(new WorkflowSuspendedEvent('wf-watch-fallback'));

    await waitFor(async () => published.length === 1, { label: 'watch event published' });
    handle.dispose();
    engine[Symbol.dispose]();

    expect(published[0]!.channel).toBe('/v1/workflows/wf-watch-fallback/watch');
    expect(JSON.parse(published[0]!.message)).toMatchObject({
      type: WorkflowSuspendedEvent.type,
      sequence: 0,
      cursor: '0',
      data: { workflowId: 'wf-watch-fallback' },
    });
  });

  it('logs and suppresses fleet append failures', async () => {
    const engine = new Engine({ storage: new MemoryStorage() });
    const logged: unknown[][] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      logged.push(args);
    };
    const handle = wireEventBroadcasting(engine, { publish() {} } as never, {
      fleetEventFeed: {
        append: async () => {
          throw new Error('fleet append failed');
        },
      } as never,
    });

    try {
      engine.dispatchEvent(new AlertFiredEvent('queue-depth', 10, 11));
      await waitFor(async () => logged.length === 1, { label: 'fleet append failure logged' });
    } finally {
      console.error = originalError;
      handle.dispose();
      engine[Symbol.dispose]();
    }

    expect(logged[0]![0]).toBe(`[weft] Failed to append fleet event "${AlertFiredEvent.type}":`);
    expect(logged[0]![1]).toBeInstanceOf(Error);
  });
});
