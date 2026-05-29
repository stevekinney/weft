import { describe, expect, it } from 'bun:test';
import type { WorkflowEvent } from '../core/types.ts';
import { sleepForTesting } from '../testing/fake-timers.test-support.ts';
import { FakeWebSocketServer } from './event-stream.test-support.ts';
import {
  WorkflowEventSubscription,
  workflowWatchWebSocketUrl,
  type EventHistoryFetcher,
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
