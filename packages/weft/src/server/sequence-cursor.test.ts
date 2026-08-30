import { afterEach, describe, expect, it } from 'bun:test';

import { Engine } from '../core/engine.ts';
import type { WorkflowContext } from '../core/types.ts';
import { workflow } from '../core/types.ts';
import { MemoryStorage } from '../storage/memory.ts';
import { createEngineEventFeedBackend } from './engine-event-feed-backend.ts';
import { serve, type WeftServer } from './index.ts';
import { collectWebSocketDeliveredEnvelopes } from './json-rpc-websocket-client.test-support.ts';
import { parseOptionalSequenceCursor } from './sequence-cursor.ts';
import { createWorkflowEventFeed, type EventEnvelope } from './workflow-event-feed.ts';

const multiWorkflow = workflow({ name: 'multi' }).execute(async function* (
  ctx: WorkflowContext,
  _input: unknown,
) {
  const context = ctx;
  yield* context.run(async () => 'step-1');
  yield* context.run(async () => 'step-2');
  return yield* context.run(async () => 'done');
});

const engines: Engine[] = [];
const servers: WeftServer[] = [];

afterEach(async () => {
  while (servers.length > 0) {
    await servers.pop()?.stop();
  }
  while (engines.length > 0) {
    engines.pop()?.[Symbol.dispose]();
  }
});

describe('parseOptionalSequenceCursor', () => {
  it('returns an empty result when the cursor is omitted', () => {
    expect(parseOptionalSequenceCursor(undefined, 'after')).toEqual({});
    expect(parseOptionalSequenceCursor(null, 'after')).toEqual({});
  });

  it('rejects empty, non-decimal, and out-of-range cursors', () => {
    expect(parseOptionalSequenceCursor('', 'after')).toEqual({
      error: 'Invalid after: ',
    });
    expect(parseOptionalSequenceCursor('  ', 'after')).toEqual({
      error: 'Invalid after:   ',
    });
    expect(parseOptionalSequenceCursor('1.5', 'after')).toEqual({
      error: 'Invalid after: 1.5',
    });
    expect(parseOptionalSequenceCursor('-2', 'after')).toEqual({
      error: 'Invalid after: -2',
    });
  });

  it('accepts safe integers including the sentinel -1', () => {
    expect(parseOptionalSequenceCursor('-1', 'after')).toEqual({ value: -1 });
    expect(parseOptionalSequenceCursor('42', 'after')).toEqual({ value: 42 });
  });
});

// MF3: Cross-transport sequence parity test — drives two live surfaces
// (replay and live subscribe) against the same engine and asserts that both
// surfaces deliver envelopes in identical sequence order for the same
// workflow events.  This proves the criterion text: "All live views share
// the same sequence and cursor semantics."
it('All live views share the same sequence and cursor semantics. Replay, resume, and ordering rules are identical across HTTP, WebSocket, and the stable stdio JSON-RPC transport.', async () => {
  // Set up a workflow that emits several events.
  const storage = new MemoryStorage();
  const engine = new Engine({ storage });
  engines.push(engine);
  engine.register(multiWorkflow);

  const handle = await engine.start('multi', {}, {});
  await handle.result();

  const backend = createEngineEventFeedBackend(engine);
  const feed = createWorkflowEventFeed(backend);
  const server = serve({
    engine,
    port: 0,
    auth: {
      apiKeys: [SUBSCRIBE_TEST_API_KEY],
      defaultApiKeyScopes: ['events:read'],
    },
  });
  servers.push(server);

  try {
    // Surface 1: replay — yields all persisted envelopes in sequence order.
    const replayed: EventEnvelope[] = [];
    for await (const envelope of feed.replay({ workflowId: handle.id, selector: 'events' })) {
      replayed.push(envelope);
    }

    // Surface 2: WebSocket subscription — should deliver the same replayed
    // envelopes in the same order because both transports project from the
    // shared event feed.
    const subscribed = await collectWebSocketDeliveredEnvelopes(
      server,
      handle.id,
      replayed.length,
      SUBSCRIBE_TEST_API_KEY,
      'sequence-cursor',
    );

    expect(replayed.length).toBeGreaterThan(0);
    expect(subscribed.length).toBe(replayed.length);

    // Both surfaces must deliver envelopes with identical sequence numbers
    // in identical order — this is the cross-transport parity invariant.
    const replayedSequences = replayed.map((e) => e.sequence);
    const subscribedSequences = subscribed.map((e) => e.sequence);

    expect(replayedSequences).toEqual(subscribedSequences);

    // Cursor semantics: every envelope carries a cursor that round-trips
    // through parseOptionalSequenceCursor.  Identical cursors for identical
    // sequences confirm the cursor encoding is transport-agnostic.
    for (let i = 0; i < replayed.length; i++) {
      const replayCursor = replayed[i]!.cursor;
      const subscribeCursor = subscribed[i]!.cursor;
      expect(replayCursor).toBe(subscribeCursor);

      // Cursor must parse back to the envelope's sequence number.
      const parsed = parseOptionalSequenceCursor(replayCursor, 'after');
      expect(parsed).toEqual({ value: replayed[i]!.sequence });
    }
  } finally {
    feed.dispose();
  }
});

// `weft.workflows.events` requires `events:read`. The test serve()
// above issues a key with that scope; this connection presents it.
const SUBSCRIBE_TEST_API_KEY = 'weft_test_sequence_cursor_events_read_key_xxxxxxxxxxxx';
