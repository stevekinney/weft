import { describe, expect, it } from 'bun:test';
import type { WorkflowEvent } from '../core/types.ts';
import { sleepForTesting } from '../testing/fake-timers.test-support.ts';
import { defaultWebSocketFactory, workflowWatchWebSocketUrl } from './event-stream-transport.ts';
import { FakeWebSocketServer } from './event-stream.test-support.ts';
import {
  openClientEventSubscription,
  WorkflowEventSubscription,
  type EventHistoryFetcher,
  type WorkflowEventStreamHost,
} from './event-stream.ts';

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for predicate');
    await sleepForTesting(2);
  }
}

const noHistory: EventHistoryFetcher = async () => [];

function event(type: string, data: Record<string, unknown> = {}): WorkflowEvent {
  return { type, timestamp: 1, data };
}

describe('workflowWatchWebSocketUrl', () => {
  it('rewrites http(s) to ws(s) and targets the /watch channel', () => {
    expect(workflowWatchWebSocketUrl('http://localhost:3000', 'wf-1')).toBe(
      'ws://localhost:3000/v1/workflows/wf-1/watch',
    );
    expect(workflowWatchWebSocketUrl('https://example.test/', 'a/b')).toBe(
      'wss://example.test/v1/workflows/a%2Fb/watch',
    );
  });

  it('resolves a relative base URL against the page origin so the socket URL is absolute', () => {
    const originalLocation = Object.getOwnPropertyDescriptor(globalThis, 'location');
    Object.defineProperty(globalThis, 'location', {
      configurable: true,
      value: { origin: 'https://app.test' },
    });
    try {
      // The empty, root, and sub-path bases are the forms browser and
      // service-worker deployments use, where REST `fetch` resolves relatively.
      expect(workflowWatchWebSocketUrl('', 'wf-1')).toBe('wss://app.test/v1/workflows/wf-1/watch');
      expect(workflowWatchWebSocketUrl('/', 'wf-1')).toBe('wss://app.test/v1/workflows/wf-1/watch');
      expect(workflowWatchWebSocketUrl('/weft', 'wf-1')).toBe(
        'wss://app.test/weft/v1/workflows/wf-1/watch',
      );
    } finally {
      if (originalLocation === undefined) {
        delete (globalThis as { location?: unknown }).location;
      } else {
        Object.defineProperty(globalThis, 'location', originalLocation);
      }
    }
  });

  it('rewrites an http page origin to ws when resolving a relative base URL', () => {
    const originalLocation = Object.getOwnPropertyDescriptor(globalThis, 'location');
    Object.defineProperty(globalThis, 'location', {
      configurable: true,
      value: { origin: 'http://localhost:7233' },
    });
    try {
      expect(workflowWatchWebSocketUrl('/weft', 'wf-1')).toBe(
        'ws://localhost:7233/weft/v1/workflows/wf-1/watch',
      );
    } finally {
      if (originalLocation === undefined) {
        delete (globalThis as { location?: unknown }).location;
      } else {
        Object.defineProperty(globalThis, 'location', originalLocation);
      }
    }
  });
});

describe('WorkflowEventSubscription', () => {
  it('pushes delivered watch-channel events to the callback', async () => {
    const server = new FakeWebSocketServer();
    const received: WorkflowEvent[] = [];
    const subscription = new WorkflowEventSubscription(
      'ws://test/watch',
      { Authorization: 'Bearer token' },
      'wf-1',
      noHistory,
      (e) => received.push(e),
      { webSocketFactory: server.factory },
    );

    await waitFor(() => server.sockets.length === 1 && server.latest().opened);
    server.latest().deliver(event('workflow:started', { phase: 1 }));
    await waitFor(() => received.length === 1);

    expect(received[0]).toEqual({ type: 'workflow:started', timestamp: 1, data: { phase: 1 } });
    subscription.close();
  });

  it('catches up from persisted history on connect (events emitted before subscribing)', async () => {
    const server = new FakeWebSocketServer();
    const received: WorkflowEvent[] = [];
    const history: EventHistoryFetcher = async () => [
      event('workflow:started'),
      event('activity:started'),
    ];
    const subscription = new WorkflowEventSubscription(
      'ws://test/watch',
      {},
      'wf-2',
      history,
      (e) => received.push(e),
      { webSocketFactory: server.factory },
    );

    await waitFor(() => received.length === 2);
    expect(received.map((e) => e.type)).toEqual(['workflow:started', 'activity:started']);

    // A live frame after catch-up is delivered exactly once (not duplicated).
    server.latest().deliver(event('workflow:completed', { result: 'ok' }));
    await waitFor(() => received.length === 3);
    expect(received.map((e) => e.type)).toEqual([
      'workflow:started',
      'activity:started',
      'workflow:completed',
    ]);
    expect(subscription.closeReason).toBe('workflow-terminal');
  });

  it('overlap dedup is consuming: keeps a second identical live frame that history did not cover', async () => {
    // Regression: the overlap-window dedup must consume each history entry at
    // most once. Two structurally identical live frames buffered during the
    // fetch, where history covers only one, must not both be dropped — the
    // genuinely new second frame has to survive.
    const server = new FakeWebSocketServer();
    const received: WorkflowEvent[] = [];

    const fetchStarted = Promise.withResolvers<void>();
    const releaseFetch = Promise.withResolvers<void>();
    const history: EventHistoryFetcher = async () => {
      fetchStarted.resolve();
      await releaseFetch.promise;
      // History covers exactly one of the two identical live frames.
      return [event('signal:received', { name: 'tick' })];
    };

    const subscription = new WorkflowEventSubscription(
      'ws://test/watch',
      {},
      'wf-dedup',
      history,
      (e) => received.push(e),
      { webSocketFactory: server.factory },
    );

    // Socket is open and the catch-up fetch is in flight; both identical frames
    // land in the live buffer before history resolves.
    await fetchStarted.promise;
    await waitFor(() => server.sockets.length === 1 && server.latest().opened);
    server.latest().deliver(event('signal:received', { name: 'tick' }));
    server.latest().deliver(event('signal:received', { name: 'tick' }));

    releaseFetch.resolve();

    // History emits one; one buffered frame overlaps and is dropped; the second
    // identical frame is genuinely new and must still be delivered.
    await waitFor(() => received.length === 2);
    expect(received.map((e) => e.type)).toEqual(['signal:received', 'signal:received']);
    subscription.close();
  });

  it('does not buffer events for a callback-only subscriber (no unbounded growth)', async () => {
    // Regression: HttpHandle.addEventListener uses only the push callback and
    // never iterates. Emitted events must not pile up in the iterator buffer for
    // the subscription's lifetime. Observable proxy: after delivering events with
    // no active iterator, starting one must not replay the already-pushed events.
    const server = new FakeWebSocketServer();
    const pushed: string[] = [];
    const subscription = new WorkflowEventSubscription(
      'ws://test/watch',
      {},
      'wf-leak',
      noHistory,
      (e) => pushed.push(e.type),
      { webSocketFactory: server.factory },
    );

    await waitFor(() => server.sockets.length === 1 && server.latest().opened);
    // Deliver several events while nobody is iterating.
    server.latest().deliver(event('activity:started'));
    server.latest().deliver(event('activity:completed'));
    server.latest().deliver(event('signal:received', { name: 'a' }));
    await waitFor(() => pushed.length === 3);
    expect(pushed).toEqual(['activity:started', 'activity:completed', 'signal:received']);

    // Now start iterating; only events delivered after iteration began appear —
    // the three earlier events were never buffered.
    const iterated: string[] = [];
    const consume = (async () => {
      for await (const e of subscription) iterated.push(e.type);
    })();
    server.latest().deliver(event('workflow:completed', { result: 'ok' }));
    await consume;

    expect(iterated).toEqual(['workflow:completed']);
    expect(subscription.closeReason).toBe('workflow-terminal');
  });

  it('async-iterates events and terminates on a terminal event', async () => {
    const server = new FakeWebSocketServer();
    const subscription = new WorkflowEventSubscription(
      'ws://test/watch',
      {},
      'wf-3',
      noHistory,
      () => {},
      { webSocketFactory: server.factory },
    );

    const collected: string[] = [];
    const consume = (async () => {
      for await (const e of subscription) collected.push(e.type);
    })();

    await waitFor(() => server.sockets.length === 1 && server.latest().opened);
    server.latest().deliver(event('activity:started'));
    server.latest().deliver(event('workflow:completed', { result: 'done' }));

    await consume;
    expect(collected).toEqual(['activity:started', 'workflow:completed']);
    expect(subscription.closeReason).toBe('workflow-terminal');
  });

  it('reconnects after a dropped socket and catches up on missed events', async () => {
    const server = new FakeWebSocketServer();
    const received: WorkflowEvent[] = [];
    // History grows over time: after the drop, the catch-up sees the event that
    // was emitted while disconnected and the terminal event.
    let historyCalls = 0;
    const history: EventHistoryFetcher = async () => {
      historyCalls += 1;
      if (historyCalls === 1) return [event('workflow:started')];
      return [event('workflow:started'), event('activity:completed'), event('workflow:completed')];
    };
    const subscription = new WorkflowEventSubscription(
      'ws://test/watch',
      {},
      'wf-4',
      history,
      (e) => received.push(e),
      { webSocketFactory: server.factory, reconnectBackoffMs: 1 },
    );

    await waitFor(() => received.length === 1);
    expect(received.map((e) => e.type)).toEqual(['workflow:started']);

    // Drop the socket; the subscription reconnects and catches up on the two
    // events it missed while disconnected.
    server.latest().drop();
    await waitFor(() => server.sockets.length === 2);

    await waitFor(() => received.length === 3);
    expect(received.map((e) => e.type)).toEqual([
      'workflow:started',
      'activity:completed',
      'workflow:completed',
    ]);
    expect(subscription.closeReason).toBe('workflow-terminal');
  });

  it('re-runs catch-up when the socket drops while the first history fetch is in flight', async () => {
    // Regression: a socket dropping mid-catch-up must not leave the stream stuck
    // on a stale snapshot. The first catch-up reconciles against the dropped
    // socket; once it resolves it must hand off to a fresh catch-up for the
    // reconnected socket so events missed in between are still delivered.
    const server = new FakeWebSocketServer();
    const received: WorkflowEvent[] = [];

    // Gate the first history fetch so the test can drop the socket while it is
    // pending. Later fetches resolve immediately with the fuller history.
    let historyCalls = 0;
    const firstFetchStarted = Promise.withResolvers<void>();
    const releaseFirstFetch = Promise.withResolvers<void>();
    const history: EventHistoryFetcher = async () => {
      historyCalls += 1;
      if (historyCalls === 1) {
        firstFetchStarted.resolve();
        await releaseFirstFetch.promise;
        // Stale snapshot captured against the now-dropped socket.
        return [event('workflow:started')];
      }
      // Fresh catch-up after reconnect sees the event missed during the gap.
      return [event('workflow:started'), event('activity:completed'), event('workflow:completed')];
    };

    const subscription = new WorkflowEventSubscription(
      'ws://test/watch',
      {},
      'wf-race',
      history,
      (e) => received.push(e),
      { webSocketFactory: server.factory, reconnectBackoffMs: 1 },
    );

    // First socket opened and its catch-up is awaiting history.
    await firstFetchStarted.promise;
    expect(server.sockets.length).toBe(1);

    // Drop the socket while the first fetch is still pending; the subscription
    // reconnects, but the new socket's catch-up is blocked by the in-flight guard.
    server.latest().drop();
    await waitFor(() => server.sockets.length === 2 && server.latest().opened);

    // Now let the stale first fetch resolve. The fix re-runs catch-up for the
    // reconnected socket, delivering the events missed during the gap.
    releaseFirstFetch.resolve();

    await waitFor(() => received.length === 3);
    expect(received.map((e) => e.type)).toEqual([
      'workflow:started',
      'activity:completed',
      'workflow:completed',
    ]);
    expect(historyCalls).toBeGreaterThanOrEqual(2);
    expect(subscription.closeReason).toBe('workflow-terminal');
  });

  it('does not inflate the history cursor when a new socket delivers live frames during a stale fetch', async () => {
    // Regression: when S1 drops mid-fetch and S2 delivers live frames before the
    // stale fetch resolves, the stale catch-up must NOT emit history or drain the
    // buffered S2 frames — doing so would inflate #deliveredCount and make the
    // fresh catch-up skip gap events and duplicate the S2 frames. The stale pass
    // abandons cleanly and the fresh re-run reconciles from a correct cursor.
    const server = new FakeWebSocketServer();
    const received: WorkflowEvent[] = [];

    let historyCalls = 0;
    const firstFetchStarted = Promise.withResolvers<void>();
    const releaseFirstFetch = Promise.withResolvers<void>();
    const history: EventHistoryFetcher = async () => {
      historyCalls += 1;
      if (historyCalls === 1) {
        firstFetchStarted.resolve();
        await releaseFirstFetch.promise;
        // S1-era snapshot: only the first event existed when S1 connected.
        return [event('workflow:started')];
      }
      // Fresh S2 catch-up: the full ordered sequence — the gap event emitted
      // while disconnected and the live frame S2 delivered during the stale
      // fetch are both persisted and present here.
      return [
        event('workflow:started'),
        event('activity:started'),
        event('signal:received', { name: 's2' }),
        event('workflow:completed'),
      ];
    };

    const subscription = new WorkflowEventSubscription(
      'ws://test/watch',
      {},
      'wf-xgen',
      history,
      (e) => received.push(e),
      { webSocketFactory: server.factory, reconnectBackoffMs: 1 },
    );

    // S1 open, first fetch in flight.
    await firstFetchStarted.promise;
    expect(server.sockets.length).toBe(1);

    // Drop S1; S2 reconnects (its catch-up is blocked by the in-flight guard).
    server.latest().drop();
    await waitFor(() => server.sockets.length === 2 && server.latest().opened);

    // S2 delivers a live frame while the stale fetch is still pending — it is
    // buffered in #pendingLive (catch-up is in flight).
    server.latest().deliver(event('signal:received', { name: 's2' }));

    // Release the stale fetch; the stale pass must abandon, and the fresh re-run
    // delivers the full sequence exactly once each — no skipped gap, no dupes.
    releaseFirstFetch.resolve();

    await waitFor(() => received.length === 4);
    expect(received.map((e) => e.type)).toEqual([
      'workflow:started',
      'activity:started',
      'signal:received',
      'workflow:completed',
    ]);
    // The s2 signal appears exactly once (not duplicated by the fresh history).
    expect(received.filter((e) => e.type === 'signal:received')).toHaveLength(1);
    expect(subscription.closeReason).toBe('workflow-terminal');
  });

  it('terminates after reconnect attempts are exhausted', async () => {
    const server = new FakeWebSocketServer();
    server.autoOpen = false; // never connect, so every socket immediately drops
    const subscription = new WorkflowEventSubscription(
      'ws://test/watch',
      {},
      'wf-5',
      noHistory,
      () => {},
      { webSocketFactory: server.factory, maxReconnectAttempts: 2, reconnectBackoffMs: 1 },
    );

    await waitFor(() => server.sockets.length >= 1);
    server.sockets[0]!.drop();
    await waitFor(() => server.sockets.length >= 2);
    server.sockets[1]!.drop();
    await waitFor(() => server.sockets.length >= 3);
    server.sockets[2]!.drop();

    await waitFor(() => subscription.closeReason !== null);
    expect(subscription.closeReason).toBe('reconnect-exhausted');
  });

  it('close() closes the socket and resolves an active iterator', async () => {
    const server = new FakeWebSocketServer();
    const subscription = new WorkflowEventSubscription(
      'ws://test/watch',
      {},
      'wf-6',
      noHistory,
      () => {},
      { webSocketFactory: server.factory },
    );

    const consume = (async () => {
      const events: string[] = [];
      for await (const e of subscription) events.push(e.type);
      return events;
    })();

    await waitFor(() => server.sockets.length === 1 && server.latest().opened);
    server.latest().deliver(event('activity:started'));

    subscription.close();
    const events = await consume;

    expect(events).toEqual(['activity:started']);
    expect(server.latest().closed).toBe(true);
    expect(subscription.closeReason).toBe('client-closed');
  });

  it('survives a failed history catch-up and keeps delivering live frames', async () => {
    const server = new FakeWebSocketServer();
    const received: WorkflowEvent[] = [];
    const failingHistory: EventHistoryFetcher = async () => {
      throw new Error('history fetch failed');
    };
    const subscription = new WorkflowEventSubscription(
      'ws://test/watch',
      {},
      'wf-7',
      failingHistory,
      (e) => received.push(e),
      { webSocketFactory: server.factory },
    );

    await waitFor(() => server.sockets.length === 1 && server.latest().opened);
    // Give the failed catch-up a moment to settle, then deliver a live frame.
    await sleepForTesting(5);
    server.latest().deliver(event('workflow:started'));
    await waitFor(() => received.length === 1);
    expect(received[0]?.type).toBe('workflow:started');
    subscription.close();
  });
});

describe('openClientEventSubscription', () => {
  it('wires the host baseUrl, headers, getEvents catch-up, and stream options', async () => {
    const server = new FakeWebSocketServer();
    const received: WorkflowEvent[] = [];
    const getEventsCalls: string[] = [];
    const host: WorkflowEventStreamHost = {
      baseUrl: 'http://localhost:3000',
      headers: { Authorization: 'Bearer token' },
      getEvents: async (workflowId) => {
        getEventsCalls.push(workflowId);
        return [event('workflow:started')];
      },
    };

    const subscription = openClientEventSubscription(
      host,
      { webSocketFactory: server.factory },
      'wf-host',
      (e) => received.push(e),
    );

    // The host's getEvents fed the connect catch-up for the requested workflow.
    await waitFor(() => received.length === 1);
    expect(getEventsCalls).toEqual(['wf-host']);
    expect(received[0]?.type).toBe('workflow:started');

    // The socket targets the watch channel derived from the host's baseUrl.
    expect(server.sockets.length).toBe(1);
    expect(server.latest().url).toBe('ws://localhost:3000/v1/workflows/wf-host/watch');

    // Live frames after catch-up are delivered exactly once.
    server.latest().deliver(event('workflow:completed', { result: 'ok' }));
    await waitFor(() => received.length === 2);
    expect(received.map((e) => e.type)).toEqual(['workflow:started', 'workflow:completed']);
    subscription.close();
  });
});

describe('WorkflowEventSubscription bufferForIteration', () => {
  it('delivers connect catch-up to a for-await consumer that starts iterating after whenConnected (tail() pattern)', async () => {
    // Regression: `tail()` opens the subscription with a no-op callback, and the
    // documented pattern is `await tail.whenConnected(); for await (…)`. Because
    // `whenConnected()` resolves only after the connect catch-up has been
    // emitted, an iterator obtained afterwards must still receive that history.
    // Without `bufferForIteration` the catch-up was dropped (the buffer only
    // filled once `#iterating` flipped, which happened too late).
    const server = new FakeWebSocketServer();
    const history: EventHistoryFetcher = async () => [
      event('workflow:started'),
      event('activity:started'),
    ];
    const subscription = new WorkflowEventSubscription(
      'ws://test/watch',
      {},
      'wf-buffer',
      history,
      () => {},
      { webSocketFactory: server.factory, bufferForIteration: true },
    );

    // Mirror the tail() usage: wait for the stream to be live (catch-up done)
    // BEFORE starting iteration.
    await subscription.whenConnected();

    const collected: string[] = [];
    const consume = (async () => {
      for await (const e of subscription) collected.push(e.type);
    })();

    // The catch-up history emitted before iteration began is still delivered.
    await waitFor(() => collected.length === 2);
    expect(collected).toEqual(['workflow:started', 'activity:started']);

    // A subsequent live terminal frame ends the iteration cleanly.
    server.latest().deliver(event('workflow:completed', { result: 'ok' }));
    await consume;
    expect(collected).toEqual(['workflow:started', 'activity:started', 'workflow:completed']);
    expect(subscription.closeReason).toBe('workflow-terminal');
  });

  it('leaves the iterator buffer empty for callback-only subscribers (no leak when bufferForIteration is off)', async () => {
    // The default (callback-only, e.g. HttpHandle.addEventListener) must not
    // accumulate a never-drained iterator buffer. We verify that an iterator
    // obtained late still sees only post-iteration frames, confirming the buffer
    // was not silently filling for the callback path.
    const server = new FakeWebSocketServer();
    const callbackEvents: string[] = [];
    const history: EventHistoryFetcher = async () => [event('workflow:started')];
    const subscription = new WorkflowEventSubscription(
      'ws://test/watch',
      {},
      'wf-callback',
      history,
      (e) => callbackEvents.push(e.type),
      { webSocketFactory: server.factory },
    );

    await subscription.whenConnected();
    expect(callbackEvents).toEqual(['workflow:started']);

    // Start iterating only now; the pre-iteration catch-up was delivered to the
    // callback but was not buffered for the iterator (no leak).
    const collected: string[] = [];
    const consume = (async () => {
      for await (const e of subscription) collected.push(e.type);
    })();

    server.latest().deliver(event('workflow:completed', { result: 'ok' }));
    await consume;
    expect(collected).toEqual(['workflow:completed']);
  });
});

describe('defaultWebSocketFactory', () => {
  it('throws an actionable error when no global WebSocket is available', () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'WebSocket');
    // Simulate a runtime without a built-in WebSocket (e.g. older Node).
    Object.defineProperty(globalThis, 'WebSocket', { configurable: true, value: undefined });
    try {
      expect(() => defaultWebSocketFactory('ws://test/watch', {})).toThrow(
        /No global WebSocket is available.*webSocketFactory/s,
      );
    } finally {
      if (descriptor === undefined) {
        delete (globalThis as { WebSocket?: unknown }).WebSocket;
      } else {
        Object.defineProperty(globalThis, 'WebSocket', descriptor);
      }
    }
  });
});

describe('WorkflowEventSubscription first-connect failure', () => {
  it('propagates a factory error on the initial connect instead of spinning reconnects', () => {
    // The first connect runs synchronously in the constructor. A failure there
    // (e.g. no WebSocket global) is an environment problem, not a transient
    // drop, so it must surface to the caller rather than retry to exhaustion.
    expect(
      () =>
        new WorkflowEventSubscription('ws://test/watch', {}, 'wf-fatal', noHistory, () => {}, {
          webSocketFactory: () => {
            throw new Error('no websocket');
          },
          reconnectBackoffMs: 1,
        }),
    ).toThrow('no websocket');
  });
});
