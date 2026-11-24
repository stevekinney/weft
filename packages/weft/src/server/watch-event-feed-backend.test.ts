import { MemoryStorage } from "../embedded/storage/src/index.ts";
import { afterEach, describe, expect, it } from 'bun:test';

import { encode } from '../core/codec.ts';
import { Engine } from '../core/engine.ts';
import { KEYS } from '../storage/keys.ts';
import { createWatchEventFeed } from './watch-event-feed-backend.ts';
import type { EventEnvelope } from './workflow-event-feed.ts';

const engines: Engine[] = [];

afterEach(async () => {
  for (const engine of engines.splice(0)) await engine[Symbol.asyncDispose]();
});

function createEngine(): Engine {
  const engine = new Engine({ storage: new MemoryStorage() });
  engines.push(engine);
  return engine;
}

function watchMessage(type: string, sequence: number): string {
  return JSON.stringify({
    type,
    timestamp: 1_000 + sequence,
    data: { workflowId: 'wf', sequence },
    sequence,
    cursor: String(sequence),
  });
}

async function storeWatchEvent(engine: Engine, type: string, sequence: number): Promise<void> {
  await engine.storage.put(
    KEYS.watchEvent('wf', sequence),
    encode(JSON.parse(watchMessage(type, sequence))),
  );
}

async function collect(source: AsyncIterable<EventEnvelope>): Promise<EventEnvelope[]> {
  const envelopes: EventEnvelope[] = [];
  for await (const envelope of source) envelopes.push(envelope);
  return envelopes;
}

describe('createWatchEventFeed', () => {
  it('replays stored watch events as envelopes after a cursor and skips a corrupt entry', async () => {
    const engine = createEngine();
    const feed = createWatchEventFeed(engine);
    await storeWatchEvent(engine, 'workflow:started', 0);
    await engine.storage.put(KEYS.watchEvent('wf', 1), new Uint8Array([0xff, 0x00, 0xff]));
    await storeWatchEvent(engine, 'workflow:completed', 2);

    const all = await collect(feed.replay({ workflowId: 'wf', selector: 'events' }));
    expect(all.map((envelope) => [envelope.kind, envelope.sequence, envelope.cursor])).toEqual([
      ['workflow:started', 0, '0'],
      ['workflow:completed', 2, '2'],
    ]);
    expect(all[0]).toMatchObject({
      workflowId: 'wf',
      selector: 'events',
      emittedAtMs: 1_000,
      payload: { workflowId: 'wf', sequence: 0 },
    });

    const afterFirst = await collect(
      feed.replay({ workflowId: 'wf', selector: 'events', fromCursor: '0' }),
    );
    expect(afterFirst.map((envelope) => envelope.sequence)).toEqual([2]);
  });

  it('serves the token selector from the engine, which has no tokens for an unknown workflow', async () => {
    const feed = createWatchEventFeed(createEngine());
    expect(await collect(feed.replay({ workflowId: 'wf', selector: 'tokens' }))).toEqual([]);

    const controller = new AbortController();
    const replayed = Promise.withResolvers<void>();
    const subscription = feed.subscribe({
      workflowId: 'wf',
      selector: 'tokens',
      signal: controller.signal,
      onReplayComplete: () => replayed.resolve(),
    });
    const drained = collect(subscription);
    await replayed.promise;
    controller.abort();
    expect(await drained).toEqual([]);
  });

  it('hands a notified watch event to a live subscriber exactly once, then stops after abort', async () => {
    const engine = createEngine();
    const feed = createWatchEventFeed(engine);
    await storeWatchEvent(engine, 'workflow:started', 0);

    const controller = new AbortController();
    const replayed = Promise.withResolvers<void>();
    const received: EventEnvelope[] = [];
    const delivered = Promise.withResolvers<void>();
    const drained = (async () => {
      for await (const envelope of feed.subscribe({
        workflowId: 'wf',
        selector: 'events',
        signal: controller.signal,
        onReplayComplete: () => replayed.resolve(),
      })) {
        received.push(envelope);
        if (envelope.kind === 'workflow:completed') delivered.resolve();
      }
    })();
    await replayed.promise;

    await storeWatchEvent(engine, 'workflow:completed', 1);
    feed.notify('wf', 1, watchMessage('workflow:completed', 1));
    // A message that is not a watch event, and one for a workflow nobody follows, are ignored.
    feed.notify('wf', 2, JSON.stringify({ type: 'workflow:failed' }));
    feed.notify('other', 0, watchMessage('workflow:started', 0));
    await delivered.promise;
    controller.abort();
    await drained;

    expect(received.map((envelope) => [envelope.kind, envelope.cursor])).toEqual([
      ['workflow:started', '0'],
      ['workflow:completed', '1'],
    ]);
    // Nobody follows the workflow any more, so a later notification is a no-op.
    feed.notify('wf', 3, watchMessage('workflow:started', 3));
  });

  it('hands a notified watch event to every subscriber of the workflow', async () => {
    const engine = createEngine();
    const feed = createWatchEventFeed(engine);
    const controller = new AbortController();
    const replayed = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
    const first = Promise.withResolvers<EventEnvelope>();
    const second = Promise.withResolvers<EventEnvelope>();
    const subscribe = (
      index: number,
      outcome: PromiseWithResolvers<EventEnvelope>,
    ): Promise<void> =>
      (async () => {
        for await (const envelope of feed.subscribe({
          workflowId: 'wf',
          selector: 'events',
          signal: controller.signal,
          onReplayComplete: () => replayed[index]?.resolve(),
        })) {
          outcome.resolve(envelope);
        }
      })();
    const drained = [subscribe(0, first), subscribe(1, second)];
    await Promise.all(replayed.map((entry) => entry.promise));

    await storeWatchEvent(engine, 'workflow:started', 0);
    feed.notify('wf', 0, watchMessage('workflow:started', 0));
    const [firstEnvelope, secondEnvelope] = await Promise.all([first.promise, second.promise]);
    expect([firstEnvelope.kind, secondEnvelope.kind]).toEqual([
      'workflow:started',
      'workflow:started',
    ]);
    controller.abort();
    await Promise.all(drained);
  });
});
