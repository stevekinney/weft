import { sleepForTesting } from '../testing/fake-timers.test-support.ts';
/**
 * End-to-end integration — `serve()` WebSocket /jsonrpc endpoint wired to
 * the JSON-RPC WebSocket session adapter.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { Engine } from '../core/engine.ts';
import type { WorkflowContext } from '../core/types.ts';
import { workflow } from '../core/types.ts';
import { MemoryStorage } from '../storage/memory.ts';
import { serve, type WeftServer } from './index.ts';
import { openWebSocket, waitForMessage } from './json-rpc-websocket-client.test-support.ts';
import {
  waitForStatus as waitForStatusWithTimeout,
  type WaitableWorkflowStatus,
} from './workflow-status.test-support.ts';

const holdWorkflow = workflow({ name: 'hold' }).execute(async function* (
  ctx: WorkflowContext,
  _input: unknown,
) {
  return yield* ctx.waitForSignal<string>('release');
});

/**
 * `weft.workflows.events` (the operation that `weft.workflows.subscribe`
 * wraps) requires the `workflows:read` scope. Tests that subscribe must
 * authenticate with a key that carries that scope (passed to `openWebSocket`);
 * tests that only call public operations (e.g. `weft.workflows.get`) keep using
 * the no-auth `serve({ engine, port: 0 })` form.
 */
const SUBSCRIBE_TEST_API_KEY = 'weft_test_subscribe_workflows_read_scope_key_xxx';
const subscribeServeOptions = {
  port: 0,
  auth: {
    apiKeys: [SUBSCRIBE_TEST_API_KEY],
    defaultApiKeyScopes: ['workflows:read'] as const,
  },
};

function createHoldEngine(): Engine {
  const storage = new MemoryStorage();
  const engine = new Engine({ storage });
  engine.register(holdWorkflow);
  return engine;
}

/**
 * Wait for a workflow status over the WebSocket integration path. These tests
 * run against a real `serve()` socket, so they allow a longer 2s window than
 * the in-process default of the shared helper.
 */
function waitForStatus(
  engine: Engine,
  workflowId: string,
  status: WaitableWorkflowStatus,
  timeoutMilliseconds = 2_000,
): Promise<void> {
  return waitForStatusWithTimeout(engine, workflowId, status, timeoutMilliseconds);
}

/** WebSocket URL for the `/jsonrpc` endpoint of a running server. */
function jsonRpcWebSocketUrl(runningServer: WeftServer): string {
  return `${runningServer.url.replace('http://', 'ws://')}/jsonrpc`;
}

/**
 * Open an authenticated socket against a subscribe-capable server, send a
 * `weft.workflows.subscribe` request for `workflowId`'s events, and resolve
 * with the opened socket plus the returned `subscriptionId`. Several tests
 * begin with this exact handshake before diverging into their own assertions.
 */
async function openSubscribedEventsSocket(
  runningServer: WeftServer,
  workflowId: string,
): Promise<{ ws: WebSocket; subscriptionId: string }> {
  const ws = await openWebSocket(jsonRpcWebSocketUrl(runningServer), SUBSCRIBE_TEST_API_KEY);
  const subscribeResponsePromise = waitForMessage(
    ws,
    (parsed: any) => parsed?.id === 1 && parsed?.result?.subscriptionId,
  );
  ws.send(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'weft.workflows.subscribe',
      params: { workflowId, selector: 'events' },
    }),
  );
  const subscribeResponse = (await subscribeResponsePromise) as any;
  return { ws, subscriptionId: subscribeResponse.result.subscriptionId as string };
}

describe('serve() — WebSocket /jsonrpc', () => {
  let server: WeftServer | undefined;
  let engine: Engine | undefined;

  beforeEach(() => {
    engine = createHoldEngine();
  });

  afterEach(async () => {
    await server?.stop();
    server = undefined;
    engine = undefined;
  });

  it('test a: weft.workflows.get over WS returns a JSON-RPC success envelope', async () => {
    engine = createHoldEngine();
    const handle = await engine.start('hold', {}, {});
    await waitForStatus(engine, handle.id, 'running');

    server = serve({ engine, port: 0 });
    const wsUrl = `${server.url.replace('http://', 'ws://')}/jsonrpc`;
    const ws = await openWebSocket(wsUrl);

    const responsePromise = waitForMessage(ws, (parsed: any) => parsed?.id === 42);
    ws.send(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 42,
        method: 'weft.workflows.get',
        params: { workflowId: handle.id },
      }),
    );

    const response = (await responsePromise) as any;
    expect(response.jsonrpc).toBe('2.0');
    expect(response.id).toBe(42);
    expect(response.result).toBeDefined();
    expect(response.result.id).toBe(handle.id);
    expect(response.result.status).toBe('running');

    ws.close();
  });

  it('test b: subscribe to events selector and receive weft.events.deliver notifications', async () => {
    engine = createHoldEngine();
    const handle = await engine.start('hold', {}, {});
    await waitForStatus(engine, handle.id, 'running');

    server = serve({ engine, ...subscribeServeOptions });
    const { ws, subscriptionId } = await openSubscribedEventsSocket(server, handle.id);
    expect(subscriptionId).toBeTruthy();

    const deliverPromise = waitForMessage(
      ws,
      (parsed: any) =>
        parsed?.method === 'weft.events.deliver' &&
        parsed?.params?.subscriptionId === subscriptionId,
    );

    await engine.signal(handle.id, 'release', 'done');

    const delivered = (await deliverPromise) as any;
    expect(delivered.params.subscriptionId).toBe(subscriptionId);
    expect(delivered.params.envelope).toBeDefined();
    expect(delivered.params.envelope.workflowId).toBe(handle.id);
    // Tighten the assertion so a wrong-selector listener cannot
    // silently pass by hitting the `workflowId` check alone.
    expect(delivered.params.envelope.selector).toBe('events');
    expect(typeof delivered.params.envelope.kind).toBe('string');
    expect(typeof delivered.params.envelope.sequence).toBe('number');
    expect(delivered.params.envelope.sequence).toBeGreaterThanOrEqual(0);
    expect(typeof delivered.params.envelope.cursor).toBe('string');

    ws.close();
  });

  it('test c: unsubscribe stops further deliveries and close tears down cleanly', async () => {
    engine = createHoldEngine();
    const handle = await engine.start('hold', {}, {});
    await waitForStatus(engine, handle.id, 'running');

    server = serve({ engine, ...subscribeServeOptions });
    const { ws, subscriptionId } = await openSubscribedEventsSocket(server, handle.id);

    const unsubscribeResponsePromise = waitForMessage(ws, (parsed: any) => parsed?.id === 2);
    ws.send(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'weft.workflows.unsubscribe',
        params: { subscriptionId },
      }),
    );
    const unsubscribeResponse = (await unsubscribeResponsePromise) as any;
    expect(unsubscribeResponse.result).toBeDefined();

    // Wait for `weft.events.deliver` to arrive AND expect it to
    // time out. This is stronger than `Bun.sleep + boolean check`:
    // a timing regression where deliveries lag would previously
    // pass the sleep-based assertion vacuously; here the test only
    // passes if the promise explicitly times out.
    const deliverPromise = waitForMessage(
      ws,
      (parsed: any) =>
        parsed?.method === 'weft.events.deliver' &&
        parsed?.params?.subscriptionId === subscriptionId,
      200,
    );

    await engine.signal(handle.id, 'release', 'done');

    let timedOut = false;
    try {
      await deliverPromise;
    } catch (error) {
      if (error instanceof Error && /timed out/i.test(error.message)) {
        timedOut = true;
      } else {
        throw error;
      }
    }
    expect(timedOut).toBe(true);

    // Close the socket and guard against silently-swallowed errors
    // from `session.close()` — the close handler fires it fire-and-
    // forget with a `.catch(console.error)`, so a throw here would
    // surface only via `process.on('unhandledRejection')` otherwise.
    let leakedRejection: unknown = null;
    const rejectionHandler = (reason: unknown) => {
      leakedRejection = reason;
    };
    process.on('unhandledRejection', rejectionHandler);
    try {
      ws.close();
      // Give Bun's close handler a turn so session.close() actually
      // runs. This short sleep is a cross-handler handoff, not a
      // correctness assertion — the test's real assertion is on
      // `leakedRejection`.
      await sleepForTesting(50);
    } finally {
      process.off('unhandledRejection', rejectionHandler);
    }
    expect(leakedRejection).toBeNull();
  });

  it('test d: missing Upgrade header still routes POST /jsonrpc through the HTTP adapter', async () => {
    engine = createHoldEngine();
    const handle = await engine.start('hold', {}, {});
    await waitForStatus(engine, handle.id, 'running');

    server = serve({ engine, port: 0 });

    const response = await fetch(`${server.url}/jsonrpc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 99,
        method: 'weft.workflows.get',
        params: { workflowId: handle.id },
      }),
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.jsonrpc).toBe('2.0');
    expect(body.id).toBe(99);
    expect(body.result?.id).toBe(handle.id);
  });

  it('test e: auth failure before upgrade returns 401 on the upgrade request itself', async () => {
    engine = createHoldEngine();
    server = serve({
      engine,
      port: 0,
      auth: {
        apiKeys: ['weft_key_valid123456789012345678901'],
      },
    });

    // Send the WS upgrade as a plain HTTP request (with the
    // `Upgrade: websocket` handshake headers) and assert the server
    // returns 401. This is stronger than opening a `new WebSocket`
    // and matching `/error|close/` — that pattern is trivially
    // satisfied by any abnormal termination including, say, the
    // browser rejecting a self-signed cert. Here the 401 comes
    // directly from the auth gate BEFORE `handleWebSocketUpgrade`
    // is even called, so the test verifies what it claims to.
    const upgradeResponse = await fetch(`${server.url}/jsonrpc`, {
      method: 'GET',
      headers: {
        upgrade: 'websocket',
        connection: 'Upgrade',
        'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
        'sec-websocket-version': '13',
      },
    });
    expect(upgradeResponse.status).toBe(401);

    // Sanity: plain POST also rejected without the auth header.
    const postResponse = await fetch(`${server.url}/jsonrpc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'weft.workflows.list',
        params: {},
      }),
    });
    expect(postResponse.status).toBe(401);
  });

  it('test f: close without explicit unsubscribe tears down without unhandled rejections', async () => {
    // Adversarial: the client drops the connection without ever
    // calling `weft.workflows.unsubscribe`. The server's
    // `websocket.close` must invoke `session.close()`, which in
    // turn must abort the subscription pump and unregister the
    // engine listener — all without surfacing a process-level
    // unhandled-rejection event (from a late `emitter.send()` on a
    // closed socket, for example).
    engine = createHoldEngine();
    const handle = await engine.start('hold', {}, {});
    await waitForStatus(engine, handle.id, 'running');

    server = serve({ engine, ...subscribeServeOptions });
    const { ws } = await openSubscribedEventsSocket(server, handle.id);

    let leakedRejection: unknown = null;
    const rejectionHandler = (reason: unknown) => {
      leakedRejection = reason;
    };
    process.on('unhandledRejection', rejectionHandler);

    try {
      // Close without unsubscribing — the session should tear down
      // cleanly on the server side.
      ws.close();

      // Trigger commits AFTER close so any late emitter.send() on a
      // closed socket would either fire (expected: swallowed by the
      // session's try/catch) or leak as an unhandled rejection.
      await engine.signal(handle.id, 'release', 'done');

      // Wait for the workflow to actually reach a terminal state
      // (proving the commit path ran to completion) so the assertion
      // below is not racing with a still-in-flight commit.
      await waitForStatus(engine, handle.id, 'completed');

      // One final microtask flush so any promise rejections queued
      // by the emitter.send() → close() sequence have a turn.
      await new Promise<void>((resolve) => setImmediate(resolve));
      await new Promise<void>((resolve) => setImmediate(resolve));
    } finally {
      process.off('unhandledRejection', rejectionHandler);
    }

    expect(leakedRejection).toBeNull();
  });

  it('test g: authenticated principal survives the WS upgrade boundary', async () => {
    // Regression guard: Bun's `server.upgrade({ data })` stores the
    // `WebSocketData` object by reference, preserving methods and
    // identity. If a future change (or Bun version) ever structure-
    // cloned the upgrade data, an `AuthenticatedPrincipal`'s
    // `hasScope` method would become undefined after upgrade and
    // scope-gated operations would fail silently.
    //
    // We verify indirectly: configure api-key auth with a default
    // scope set, upgrade a WS connection with the valid key, and
    // call `weft.workflows.get` — which requires a principal. If
    // the principal did not survive the upgrade, dispatch would
    // reject with an authorization error instead of returning the
    // workflow.
    engine = createHoldEngine();
    const handle = await engine.start('hold', {}, {});
    await waitForStatus(engine, handle.id, 'running');

    const apiKey = 'weft_key_valid123456789012345678901';
    server = serve({
      engine,
      port: 0,
      auth: {
        apiKeys: [apiKey],
      },
    });

    const wsUrl = `${server.url.replace('http://', 'ws://')}/jsonrpc`;
    const ws = await new Promise<WebSocket>((resolve, reject) => {
      const socket = new WebSocket(wsUrl, {
        headers: { authorization: `Bearer ${apiKey}` },
      } as any);
      socket.addEventListener('open', () => resolve(socket));
      socket.addEventListener('error', (event: Event) => reject(event));
    });

    const responsePromise = waitForMessage(ws, (parsed: any) => parsed?.id === 1);
    ws.send(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'weft.workflows.get',
        params: { workflowId: handle.id },
      }),
    );

    const response = (await responsePromise) as any;
    expect(response.result).toBeDefined();
    expect(response.result.id).toBe(handle.id);

    ws.close();
  });

  it('test h: two concurrent clients share the feed; unsubscribing one does not starve the other', async () => {
    // The shared `WorkflowEventFeed` at `serve()` scope is a real
    // multiplexer: two clients subscribed to the same workflow each
    // register their own engine listener. This test proves that
    // closing one subscription does not drop deliveries for the
    // other — a regression that would be invisible in any of the
    // single-client tests above.
    engine = createHoldEngine();
    const handle = await engine.start('hold', {}, {});
    await waitForStatus(engine, handle.id, 'running');

    server = serve({ engine, ...subscribeServeOptions });
    const wsUrl = `${server.url.replace('http://', 'ws://')}/jsonrpc`;

    const [wsA, wsB] = await Promise.all([
      openWebSocket(wsUrl, SUBSCRIBE_TEST_API_KEY),
      openWebSocket(wsUrl, SUBSCRIBE_TEST_API_KEY),
    ]);

    async function subscribeAndAwaitId(ws: WebSocket, correlationId: number): Promise<string> {
      const responsePromise = waitForMessage(
        ws,
        (parsed: any) => parsed?.id === correlationId && parsed?.result?.subscriptionId,
      );
      ws.send(
        JSON.stringify({
          jsonrpc: '2.0',
          id: correlationId,
          method: 'weft.workflows.subscribe',
          params: { workflowId: handle.id, selector: 'events' },
        }),
      );
      const response = (await responsePromise) as any;
      return response.result.subscriptionId as string;
    }

    const [subscriptionA, subscriptionB] = await Promise.all([
      subscribeAndAwaitId(wsA, 10),
      subscribeAndAwaitId(wsB, 20),
    ]);

    // Close A — B must keep receiving deliveries.
    wsA.close();
    await sleepForTesting(20);

    const deliverBPromise = waitForMessage(
      wsB,
      (parsed: any) =>
        parsed?.method === 'weft.events.deliver' &&
        parsed?.params?.subscriptionId === subscriptionB,
      1_000,
    );

    await engine.signal(handle.id, 'release', 'done');

    const delivered = (await deliverBPromise) as any;
    expect(delivered.params.subscriptionId).toBe(subscriptionB);
    expect(delivered.params.envelope.workflowId).toBe(handle.id);
    // Subscription IDs are session-scoped, so `subscriptionA` and
    // `subscriptionB` may share a textual form across different
    // sessions. The meaningful assertion is that wsB receives the
    // delivery keyed by its OWN session's id after wsA has closed —
    // if the feed's per-workflow listener set had been corrupted by
    // A's unsubscribe, B would never see this delivery.
    void subscriptionA;

    wsB.close();
  });

  it('test i: server.stop with an active subscription drains sessions cleanly', async () => {
    // Shutdown-ordering regression guard. The shared
    // `WorkflowEventFeed` is registered in the AsyncDisposableStack
    // after the active-session close hook, so disposal runs:
    //   1. close every active /jsonrpc session (await)
    //   2. feed.dispose()
    //   3. broadcastingHandle.dispose()
    //   4. server.stop(true)
    //
    // Without step 1, the feed would dispose while subscription
    // pumps were mid-drain, producing noisy post-dispose callbacks.
    engine = createHoldEngine();
    const handle = await engine.start('hold', {}, {});
    await waitForStatus(engine, handle.id, 'running');

    server = serve({ engine, ...subscribeServeOptions });
    // Open and subscribe, but intentionally leave the client socket open: this
    // test exercises `server.stop()` draining an active subscription.
    await openSubscribedEventsSocket(server, handle.id);

    let leakedRejection: unknown = null;
    const rejectionHandler = (reason: unknown) => {
      leakedRejection = reason;
    };
    process.on('unhandledRejection', rejectionHandler);

    try {
      // Stop the server WITHOUT closing the client WS first. This
      // exercises the active-session-close defer: the stack must
      // await every session's close before the feed disposes.
      await server.stop();
      // Mark the afterEach cleanup as already done.
      server = undefined;

      // Flush microtasks so any late rejections land before the
      // assertion below.
      await new Promise<void>((resolve) => setImmediate(resolve));
      await new Promise<void>((resolve) => setImmediate(resolve));
    } finally {
      process.off('unhandledRejection', rejectionHandler);
    }

    expect(leakedRejection).toBeNull();
  });
});
