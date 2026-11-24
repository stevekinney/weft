import { describe, expect, it } from 'bun:test';

import { MemoryStorage } from "../../embedded/storage/src/index.ts";
import { quietFor, waitUntil } from "../../../test-support/embedded/testing/src/wait-until.ts";
import { StreamChunkEvent } from '../events/fleet-state-events.ts';
import { workflow } from '../types.ts';
import { Engine } from './index.ts';
import { getInternals } from './internals.ts';

const SECRET_BODY = 'chunk-body-that-must-not-leave-the-engine';

describe('stream:chunk on the Engine', () => {
  it('announces a stream by key and sequence, never by body, ending with its last stored chunk', async () => {
    await using engine = new Engine({ storage: new MemoryStorage() });
    const seen: StreamChunkEvent[] = [];
    engine.addEventListener(StreamChunkEvent.type, (event) => {
      seen.push(event);
    });
    engine.register(
      workflow({ name: 'progress-stream' }).execute(async function* (ctx) {
        yield* ctx.stream('progress', async function* () {
          yield SECRET_BODY;
          yield { step: 2 };
        });
        yield* ctx.stream('tokens', async function* () {
          yield 'token';
        });
        return 'done';
      }),
    );

    const handle = await engine.start('progress-stream', {});
    await handle.result();

    // The first chunk is announced at once and the stream's completion announces its last one, so
    // both are dispatched before the result resolves.
    expect(seen.map((event) => [event.workflowId, event.key, event.sequence])).toEqual([
      [handle.id, 'progress', 0],
      [handle.id, 'progress', 1],
    ]);
    for (const event of seen) {
      expect(Object.keys(event).toSorted()).toEqual(['isTrusted', 'key', 'sequence', 'workflowId']);
      expect(JSON.stringify(event)).not.toContain(SECRET_BODY);
    }
  });

  it('coalesces a long stream instead of announcing every chunk, and leaves no window open', async () => {
    await using engine = new Engine({ storage: new MemoryStorage() });
    const sequences: number[] = [];
    engine.addEventListener(StreamChunkEvent.type, (event) => {
      sequences.push(event.sequence);
    });
    engine.register(
      workflow({ name: 'long-stream' }).execute(async function* (ctx) {
        yield* ctx.stream('progress', async function* () {
          for (let step = 0; step < 200; step++) yield step;
        });
        return 'done';
      }),
    );

    const handle = await engine.start('long-stream', {});
    await handle.result();

    // How many windows the stream spans depends on host speed, so only the shape is asserted here;
    // the per-window bound is pinned under fake timers in `stream-chunk-announcer.test.ts`.
    expect(sequences[0]).toBe(0);
    expect(sequences.at(-1)).toBe(199);
    expect(sequences).toEqual(sequences.toSorted((left, right) => left - right));
    expect(new Set(sequences).size).toBe(sequences.length);
    expect(getInternals(engine).streamChunkAnnouncer.openWindowCount).toBe(0);
  });

  it('does not announce a chunk of the tokens key, which already reaches subscribers through the feed', async () => {
    await using engine = new Engine({ storage: new MemoryStorage() });
    const keys: string[] = [];
    engine.addEventListener(StreamChunkEvent.type, (event) => {
      keys.push(event.key);
    });
    engine.register(
      workflow({ name: 'token-only-stream' }).execute(async function* (ctx) {
        yield* ctx.stream('tokens', async function* () {
          yield 'a';
          yield 'b';
        });
        return 'done';
      }),
    );

    const handle = await engine.start('token-only-stream', {});
    await handle.result();

    expect(keys).toEqual([]);
  });

  it("does not announce a chunk a cancelled run's producer yields after a start-new replacement took the id", async () => {
    await using engine = new Engine({ storage: new MemoryStorage() });
    const seen: StreamChunkEvent[] = [];
    engine.addEventListener(StreamChunkEvent.type, (event) => {
      seen.push(event);
    });
    let producerEntered = false;
    const producerGate = Promise.withResolvers<void>();
    let runs = 0;
    engine.register(
      workflow({ name: 'restarted-stream' }).execute(async function* (ctx) {
        runs++;
        if (runs === 1) {
          yield* ctx.stream('progress', async function* () {
            producerEntered = true;
            await producerGate.promise;
            // Two chunks, so the second is held for a trailing event that must be fenced too.
            yield 'stale-chunk';
            yield 'stale-trailing-chunk';
          });
          return 'old';
        }
        yield* ctx.waitForSignal('release');
        return 'new';
      }),
    );

    const first = await engine.start('restarted-stream', {}, { id: 'restarted-stream-1' });
    await waitUntil(() => producerEntered, { message: 'old producer awaiting its gate' });
    await first.cancel();
    const replacement = await engine.start(
      'restarted-stream',
      {},
      { id: 'restarted-stream-1', onTerminalConflict: 'start-new' },
    );
    await waitUntil(() => runs === 2, { message: 'replacement run started' });

    producerGate.resolve();
    // The old producer's late write is observable through storage, so wait on that and then on
    // the event chain draining before asserting that nothing was announced.
    await waitUntil(
      async () => {
        const stored = await engine.getStreamChunks('restarted-stream-1', 'progress');
        return stored.length > 1;
      },
      { message: 'old producer stored its late chunk' },
    );
    await quietFor(50);

    expect(seen).toEqual([]);
    await replacement.cancel();
  });
});
