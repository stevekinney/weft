import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { waitForRealTimersForTesting } from '../testing/fake-timers.ts';

import { decode, encode } from '../core/codec.ts';
import { Engine } from '../core/engine.ts';
import {
  ActivityFailedEvent,
  WorkflowCancelledEvent,
  WorkflowCompletedEvent,
} from '../core/events.ts';
import type { RetryPolicy, WorkflowContext } from '../core/types.ts';
import { workflow } from '../core/types.ts';
import { MCP_PROTOCOL_VERSION } from '../mcp/protocol.ts';
import { METRICS } from '../observability/metrics.ts';
import type { Storage as WeftStorage } from '../storage/interface.ts';
import { KEYS } from '../storage/interface.ts';
import { MemoryStorage } from '../storage/memory.ts';
import { resetPublicOriginWarningForTesting } from './api-catalog.ts';
import { DeadlineTracker } from './deadline-tracker.ts';
import * as handlerModule from './handler.ts';
import type { WeftServer } from './index.ts';
import { serve, wireEventBroadcasting } from './index.ts';
import { createOperationRegistry, executeOperation } from './operation-catalog.ts';
import {
  createGetTaskDiagnosticsOperation,
  type GetTaskDiagnosticsOutput,
} from './operations/get-task-diagnostics.ts';
import { principalFromApiKey } from './principal.ts';
import type { InflightRecord, QueuedRecord, ResolvedRecord } from './task-state.ts';

const echoWorkflow = workflow({ name: 'echo' }).execute(async function* (
  _ctx: WorkflowContext,
  input: unknown,
) {
  return input;
});

class TokenEvent extends Event {
  static readonly type = 'stream:token';

  constructor(
    public readonly workflowId: string,
    public readonly token: string,
    public readonly model: string,
  ) {
    super(TokenEvent.type);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Drain microtasks so fire-and-forget work completes. */
async function flush(): Promise<void> {
  await waitForRealTimersForTesting(10);
}

/**
 * Poll an async condition until it returns true, or throw after `timeoutMs`.
 * Prefer this over raw `Bun.sleep` when waiting for a specific observable
 * state — it adapts to the actual time needed rather than guessing.
 */
async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  {
    timeoutMs = 2000,
    intervalMs = 5,
    label = 'condition',
  }: { timeoutMs?: number; intervalMs?: number; label?: string } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      if (await predicate()) return;
    } catch (error) {
      lastError = error;
    }
    await waitForRealTimersForTesting(intervalMs);
  }
  const message = `Timed out after ${timeoutMs}ms waiting for ${label}`;
  throw lastError instanceof Error
    ? new Error(`${message}: ${lastError.message}`)
    : new Error(message);
}

async function waitForSocketClose(ws: WebSocket, _label = 'WebSocket close'): Promise<void> {
  try {
    if (ws.readyState !== WebSocket.CLOSED) ws.close();
  } catch {
    // The server may already have completed the close handshake.
  }
  await waitForRealTimersForTesting(100);
}

async function waitForWorkerMessage(
  ws: WebSocket,
  predicate: (message: Record<string, unknown>) => boolean,
  label: string,
): Promise<Record<string, unknown>> {
  let matched: Record<string, unknown> | undefined;
  ws.addEventListener('message', (event) => {
    try {
      const parsed = JSON.parse(String(event.data)) as Record<string, unknown>;
      if (predicate(parsed)) matched = parsed;
    } catch {
      // Ignore non-JSON frames while waiting for protocol diagnostics.
    }
  });

  await waitFor(() => matched !== undefined, { label });
  return matched!;
}

/** Count keys under a prefix by draining an async iterator. */
async function countKeys(engine: Engine, prefix: string): Promise<number> {
  let count = 0;
  for await (const _entry of engine.storage.scan(prefix)) {
    count++;
  }
  return count;
}

function createEngine(): Engine {
  const storage = new MemoryStorage();
  const engine = new Engine({ storage });

  engine.register(echoWorkflow);

  return engine;
}

function overrideProperty<T extends object, K extends keyof T>(
  target: T,
  property: K,
  replacement: T[K],
): () => void {
  const original = target[property];
  (target as Record<PropertyKey, unknown>)[property as PropertyKey] = replacement as unknown;
  return () => {
    (target as Record<PropertyKey, unknown>)[property as PropertyKey] = original as unknown;
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('serve', () => {
  let engine: Engine;
  let server: WeftServer;

  afterEach(async () => {
    await server?.stop();
    engine?.[Symbol.dispose]();
  });

  it('starts a server on the specified port', () => {
    engine = createEngine();
    server = serve({ engine, port: 0 });

    expect(server.port).toBeGreaterThan(0);
  });

  it('serves public MCP discovery that matches the live MCP transport', async () => {
    const originalNodeEnv = Bun.env['NODE_ENV'];
    Bun.env['NODE_ENV'] = 'development';
    resetPublicOriginWarningForTesting();
    const originalWarn = console.warn;
    console.warn = () => {};
    const apiKey = 'mcp-discovery-live-key';
    engine = createEngine();
    server = serve({ engine, port: 0, auth: { apiKeys: [apiKey] } });

    try {
      const discoveryResponse = await fetch(`${server.url}/.well-known/mcp.json`);
      expect(discoveryResponse.status).toBe(200);
      const discovery = (await discoveryResponse.json()) as {
        transports?: { streamableHttp?: { url?: string; methods?: string[] } };
        discovery?: { tools?: { method?: string } };
      };
      const endpoint = discovery.transports?.streamableHttp?.url;
      expect(endpoint).toBe(`${server.url}/mcp`);
      expect(discovery.transports?.streamableHttp?.methods).toEqual(['POST', 'GET', 'DELETE']);

      const authorization = { Authorization: `Bearer ${apiKey}` };
      const methodNotAllowed = await fetch(endpoint!, {
        method: 'PUT',
        headers: authorization,
      });
      expect(methodNotAllowed.status).toBe(405);
      expect(methodNotAllowed.headers.get('allow')).toBe('POST, GET, DELETE');

      const getWithoutSession = await fetch(endpoint!, {
        method: 'GET',
        headers: { ...authorization, accept: 'text/event-stream' },
      });
      expect(getWithoutSession.status).not.toBe(405);

      const initializeResponse = await fetch(endpoint!, {
        method: 'POST',
        headers: {
          ...authorization,
          accept: 'application/json, text/event-stream',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 'initialize',
          method: 'initialize',
          params: {
            protocolVersion: MCP_PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: { name: 'weft-test-client', version: '1.0.0' },
          },
        }),
      });
      expect(initializeResponse.status).toBe(200);
      const sessionId = initializeResponse.headers.get('Mcp-Session-Id');
      expect(sessionId).toBeTruthy();

      const sessionHeaders = {
        ...authorization,
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
        'Mcp-Protocol-Version': MCP_PROTOCOL_VERSION,
        'Mcp-Session-Id': sessionId!,
      };
      const initializedResponse = await fetch(endpoint!, {
        method: 'POST',
        headers: sessionHeaders,
        body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      });
      expect(initializedResponse.status).toBe(202);

      const toolsResponse = await fetch(endpoint!, {
        method: 'POST',
        headers: sessionHeaders,
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 'tools',
          method: discovery.discovery?.tools?.method,
          params: {},
        }),
      });
      expect(toolsResponse.status).toBe(200);
      const toolsBody = (await toolsResponse.json()) as {
        result?: { tools?: unknown[] };
        error?: unknown;
      };
      expect(toolsBody.error).toBeUndefined();
      expect(Array.isArray(toolsBody.result?.tools)).toBe(true);

      const deleteResponse = await fetch(endpoint!, {
        method: 'DELETE',
        headers: sessionHeaders,
      });
      expect(deleteResponse.status).toBe(204);
    } finally {
      console.warn = originalWarn;
      if (originalNodeEnv !== undefined) Bun.env['NODE_ENV'] = originalNodeEnv;
      else delete Bun.env['NODE_ENV'];
    }
  });

  it('responds to health check (GET /v1/health)', async () => {
    engine = createEngine();
    server = serve({ engine, port: 0 });

    const response = await fetch(`${server.url}/v1/health`);

    expect(response.status).toBe(200);
    const body = (await response.json()) as { status: string };
    expect(body.status).toBe('ok');
  });

  it('serves dashboard routes when a dashboard asset is configured', async () => {
    engine = createEngine();
    server = serve({
      engine,
      port: 0,
      dashboard: new Response('<html><body>dashboard</body></html>', {
        headers: { 'Content-Type': 'text/html' },
      }),
    });

    const rootResponse = await fetch(`${server.url}/ui`);
    const nestedResponse = await fetch(`${server.url}/ui/assets/app.js`);

    expect(rootResponse.status).toBe(200);
    expect(await rootResponse.text()).toContain('dashboard');
    expect(nestedResponse.status).toBe(200);
    expect(await nestedResponse.text()).toContain('dashboard');
  });

  it('handles workflow API routes (POST /v1/workflows)', async () => {
    engine = createEngine();
    server = serve({ engine, port: 0 });

    const response = await fetch(`${server.url}/v1/workflows`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'echo', input: 'hello' }),
    });

    expect(response.status).toBe(201);
    const body = (await response.json()) as { id: string };
    expect(typeof body.id).toBe('string');
    expect(body.id.length).toBeGreaterThan(0);
  });

  it('stops cleanly via stop()', async () => {
    engine = createEngine();
    server = serve({ engine, port: 0 });
    const { url } = server;

    // Verify it is running
    const response = await fetch(`${url}/v1/health`);
    expect(response.status).toBe(200);

    await server.stop();

    // After stopping, fetch should fail
    try {
      await fetch(`${url}/v1/health`);
      // If fetch succeeds, the server did not stop — fail the test
      expect(true).toBe(false);
    } catch {
      // Expected: connection refused or similar error
      expect(true).toBe(true);
    }
  });

  it('stop() returns a Promise', () => {
    engine = createEngine();
    server = serve({ engine, port: 0 });

    const result = server.stop();
    expect(result).toBeInstanceOf(Promise);
  });

  it('stop() is idempotent', async () => {
    engine = createEngine();
    server = serve({ engine, port: 0 });

    await server.stop();
    // Second call should not throw — AsyncDisposableStack handles double-dispose.
    await server.stop();
  });

  it('stops via Symbol.asyncDispose', async () => {
    engine = createEngine();
    server = serve({ engine, port: 0 });
    const { url } = server;

    // Verify it is running
    const response = await fetch(`${url}/v1/health`);
    expect(response.status).toBe(200);

    await server[Symbol.asyncDispose]();

    try {
      await fetch(`${url}/v1/health`);
      expect(true).toBe(false);
    } catch {
      expect(true).toBe(true);
    }
  });

  it('url property returns correct URL', () => {
    engine = createEngine();
    server = serve({ engine, port: 0 });

    expect(server.url).toBe(`http://${server.hostname}:${server.port}`);
  });

  it('disposes the listening server when event broadcasting setup throws', async () => {
    engine = createEngine();
    const originalAddEventListener = engine.addEventListener.bind(engine);
    const restoreAddEventListener = overrideProperty(engine, 'addEventListener', ((
      ...args: Parameters<EventTarget['addEventListener']>
    ) => {
      const [type] = args;
      if (type === TokenEvent.type) {
        throw new Error('broadcast setup failed');
      }
      return originalAddEventListener(...args);
    }) as Engine['addEventListener']);

    try {
      expect(() => serve({ engine, port: 0 })).toThrow('broadcast setup failed');
      await waitForRealTimersForTesting(50);
    } finally {
      restoreAddEventListener();
    }
  });

  it('defaults to port 7233', () => {
    engine = createEngine();
    // Use the default port; rely on it being available in test environments
    server = serve({ engine, port: 7233 });

    expect(server.port).toBe(7233);
  });

  it('lists workflows through the server', async () => {
    engine = createEngine();
    server = serve({ engine, port: 0 });

    // Start two workflows
    await fetch(`${server.url}/v1/workflows`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'echo', input: 1 }),
    });
    await fetch(`${server.url}/v1/workflows`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'echo', input: 2 }),
    });
    await flush();

    const response = await fetch(`${server.url}/v1/workflows`);

    expect(response.status).toBe(200);
    const body = (await response.json()) as { items: unknown[]; total: number };
    expect(body.items.length).toBe(2);
    expect(body.total).toBe(2);
  });

  it('returns a WebSocket upgrade failure for non-matching upgrade requests', async () => {
    engine = createEngine();
    server = serve({ engine, port: 0 });

    // Attempt a WebSocket-style request to a non-WebSocket route
    // Bun's fetch cannot do a real WebSocket upgrade, but we can
    // verify the server handles the upgrade header gracefully
    const response = await fetch(`${server.url}/v1/health`, {
      headers: { upgrade: 'websocket' },
    });

    // The server should return 400 since upgrade fails on a non-WebSocket route
    // (or Bun may strip the upgrade header in fetch — either way, the server
    // should not crash)
    expect(response.status).toBeDefined();
  });

  it('returns 401 when principal resolution throws during a JSON-RPC WebSocket upgrade', async () => {
    engine = createEngine();
    server = serve({
      engine,
      port: 0,
      auth: {
        apiKeys: ['weft_key_valid123456789012345678901'],
      },
    });

    const principalSpy = spyOn(handlerModule, 'authContextToPrincipal').mockImplementation(() => {
      throw new Error('invalid auth context');
    });
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});

    try {
      const response = await fetch(`${server.url}/jsonrpc`, {
        method: 'GET',
        headers: {
          upgrade: 'websocket',
          connection: 'Upgrade',
          'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
          'sec-websocket-version': '13',
          'x-api-key': 'weft_key_valid123456789012345678901',
        },
      });

      expect(response.status).toBe(401);
      expect(await response.text()).toBe('Authentication context invalid');
      expect(errorSpy).toHaveBeenCalledWith(
        '[weft] /jsonrpc WS upgrade principal resolution failed',
        expect.any(Error),
      );
    } finally {
      principalSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it('accepts a WebSocket connection and subscribes to pathname channel', async () => {
    engine = createEngine();
    server = serve({ engine, port: 0 });

    const wsUrl = server.url.replace('http://', 'ws://');

    const ws = new WebSocket(`${wsUrl}/v1/workflows/test-wf/watch`);

    const opened = await new Promise<boolean>((resolve, reject) => {
      ws.addEventListener('open', () => resolve(true));
      ws.addEventListener('error', () => reject(new Error('WebSocket connection failed')));
    });

    expect(opened).toBe(true);

    // Send a message (the handler is a no-op, but ensures the message path is exercised)
    ws.send('ping');
    await waitForRealTimersForTesting(50);

    ws.close();
    await waitForRealTimersForTesting(50);
  });

  it('handles WebSocket close event without error', async () => {
    engine = createEngine();
    server = serve({ engine, port: 0 });

    const wsUrl = server.url.replace('http://', 'ws://');
    const ws = new WebSocket(`${wsUrl}/v1/tasks/default/stream`);

    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve());
      ws.addEventListener('error', () => reject(new Error('WebSocket connection failed')));
    });

    // Close the connection
    ws.close();

    await new Promise<void>((resolve) => {
      ws.addEventListener('close', () => resolve());
    });
  });

  // -------------------------------------------------------------------------
  // Regression: the per-workflow sequence bookkeeping maps inside
  // `wireEventBroadcasting` (`sequenceCounters`, `sequenceInitPromises`,
  // `sequenceChains`) used to live for the lifetime of the server process.
  // They are now dropped when a workflow reaches a terminal state, alongside
  // the existing worker-affinity cleanup. This test verifies:
  //   1. Events emitted after the terminal cleanup still persist correctly
  //      (the cleanup must not corrupt sequence tracking for the next run).
  //   2. Sequence numbers resume from storage on the post-terminal rehydration
  //      instead of restarting at 0 and overwriting the pre-terminal events.
  // -------------------------------------------------------------------------
  it('cleans up sequence bookkeeping on workflow termination without losing events', async () => {
    engine = createEngine();
    server = serve({ engine, port: 0 });

    const workflowId = 'terminal-cleanup-wf';

    // Emit a sequence of events before the terminal state.
    engine.dispatchEvent(new TokenEvent(workflowId, 'first', 'gpt-4'));
    engine.dispatchEvent(new TokenEvent(workflowId, 'second', 'gpt-4'));
    engine.dispatchEvent(new TokenEvent(workflowId, 'third', 'gpt-4'));

    // Wait until the serialization chain has persisted all three. Polling on
    // the observable count is deterministic across CI load — a raw
    // A fixed wall-clock sleep was flaky on slower runners.
    await waitFor(async () => (await countKeys(engine, `ev:${workflowId}:`)) === 3, {
      label: '3 pre-terminal events persisted',
    });

    // Mark the workflow terminal — this should trigger the sequence-map cleanup.
    engine.dispatchEvent(new WorkflowCompletedEvent(workflowId, 'ok', 1));
    // Wait until the terminal event is persisted (now 4 total). Cleanup
    // evicts the sequence maps once the current serialization chain drains;
    // by the time the 4th key is observable, cleanup has completed.
    await waitFor(async () => (await countKeys(engine, `ev:${workflowId}:`)) === 4, {
      label: 'terminal event persisted and cleanup complete',
    });

    // Emit another event for the same workflowId *after* cleanup. With the
    // sequence state evicted, `ensureSequenceInitialized` must re-read from
    // storage and resume after the highest existing sequence number — not
    // restart at 0 and overwrite the previously persisted events.
    engine.dispatchEvent(new TokenEvent(workflowId, 'post-terminal', 'gpt-4'));
    await waitFor(async () => (await countKeys(engine, `ev:${workflowId}:`)) === 5, {
      label: 'post-terminal event persisted without collision',
    });

    const keys: string[] = [];
    for await (const [key] of engine.storage.scan(`ev:${workflowId}:`)) {
      keys.push(key);
    }

    // 3 tokens + 1 terminal + 1 post-terminal = 5 distinct sequence keys.
    // If the cleanup dropped the counter mid-persist or the rehydration
    // restarted at 0, we would see fewer than 5 entries (collisions).
    expect(keys.length).toBe(5);

    // Keys are `ev:{workflowId}:{sequence}` and scan order is lexicographic.
    // Verify the sequences are contiguous (no gaps, no collisions).
    const sequences = keys.map((key) => {
      const parts = key.split(':');
      return parseInt(parts[parts.length - 1] ?? '', 10);
    });
    sequences.sort((a, b) => a - b);
    for (let i = 0; i < sequences.length; i++) {
      expect(sequences[i]).toBe(i);
    }
  });

  it('does not retain sequence state across many terminated workflows', async () => {
    engine = createEngine();
    server = serve({ engine, port: 0 });

    // Emit and terminate a batch of workflows. If the sequence maps are not
    // cleaned up on termination, each workflow leaks one entry per map; this
    // test exercises that path without relying on private-state inspection.
    // The invariant we verify is the same as the previous test (events are
    // persisted correctly), but applied across many workflows so a future
    // regression that re-introduces the leak is more likely to manifest as
    // visible behavior rather than silent memory growth.
    const workflowCount = 25;
    for (let i = 0; i < workflowCount; i++) {
      const workflowId = `bulk-wf-${i}`;
      engine.dispatchEvent(new TokenEvent(workflowId, `token-${i}`, 'gpt-4'));
      engine.dispatchEvent(new WorkflowCompletedEvent(workflowId, i, 1));
    }

    // Poll until every workflow has persisted its 2 events rather than
    // guessing a drain interval. This adapts to CI load and isolates failure
    // to the specific workflow that lagged rather than a blanket timeout.
    await waitFor(
      async () => {
        for (let i = 0; i < workflowCount; i++) {
          const count = await countKeys(engine, `ev:bulk-wf-${i}:`);
          if (count !== 2) return false;
        }
        return true;
      },
      { label: 'all 25 bulk workflows persisted their events' },
    );

    // Each workflow should have exactly 2 stored events (the token + terminal).
    for (let i = 0; i < workflowCount; i++) {
      const count = await countKeys(engine, `ev:bulk-wf-${i}:`);
      expect(count).toBe(2);
    }
  });

  it('cleanupWorkflow tolerates workflows that never started an event chain', () => {
    engine = createEngine();
    const broadcaster = wireEventBroadcasting(engine, {
      publish() {
        return 0;
      },
    } as unknown as ReturnType<typeof Bun.serve>);

    expect(() => broadcaster.cleanupWorkflow('never-broadcast')).not.toThrow();

    broadcaster.dispose();
  });

  it('publishes token stream events to the stream channel when direct delivery is unavailable', async () => {
    engine = createEngine();
    const publishedMessages: Array<{ channel: string; message: string }> = [];
    const broadcaster = wireEventBroadcasting(engine, {
      publish(channel: string, message: string) {
        publishedMessages.push({ channel, message });
        return 1;
      },
    } as unknown as ReturnType<typeof Bun.serve>);

    const workflowId = 'stream-fallback-publish-wf';
    engine.dispatchEvent(new TokenEvent(workflowId, 'hello', 'gpt-4'));

    await waitFor(() => publishedMessages.length === 2, {
      label: 'watch and stream channel publishes',
    });

    expect(publishedMessages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          channel: `/v1/workflows/${encodeURIComponent(workflowId)}/watch`,
        }),
        expect.objectContaining({
          channel: `/v1/workflows/${encodeURIComponent(workflowId)}/stream`,
        }),
      ]),
    );

    broadcaster.dispose();
  });

  it('waits for an extended post-terminal chain before dropping sequence bookkeeping', async () => {
    engine = createEngine();
    server = serve({ engine, port: 0 });

    const workflowId = 'terminal-recursion-wf';

    engine.dispatchEvent(new TokenEvent(workflowId, 'before-terminal', 'gpt-4'));
    await waitFor(async () => (await countKeys(engine, `ev:${workflowId}:`)) === 1, {
      label: 'pre-terminal event persisted',
    });

    // Dispatch the terminal event and immediately extend the same workflow's
    // event chain before the terminal cleanup can drain. This exercises the
    // recursive cleanup path inside `cleanupWorkflow`.
    engine.dispatchEvent(new WorkflowCompletedEvent(workflowId, 'ok', 1));
    engine.dispatchEvent(new TokenEvent(workflowId, 'during-terminal-cleanup', 'gpt-4'));

    await waitFor(async () => (await countKeys(engine, `ev:${workflowId}:`)) === 3, {
      label: 'terminal and immediate follow-up events persisted',
    });

    // Once the recursive cleanup has drained the extended chain, a later event
    // should rehydrate from storage and continue the sequence without
    // collisions or gaps.
    engine.dispatchEvent(new TokenEvent(workflowId, 'after-recursive-cleanup', 'gpt-4'));
    await waitFor(async () => (await countKeys(engine, `ev:${workflowId}:`)) === 4, {
      label: 'post-recursion event persisted after cleanup',
    });

    const keys: string[] = [];
    for await (const [key] of engine.storage.scan(`ev:${workflowId}:`)) {
      keys.push(key);
    }

    expect(keys.length).toBe(4);
    const sequences = keys.map((key) => {
      const parts = key.split(':');
      return parseInt(parts[parts.length - 1] ?? '', 10);
    });
    sequences.sort((a, b) => a - b);
    expect(sequences).toEqual([0, 1, 2, 3]);
  });
});

// ---------------------------------------------------------------------------
// Worker WebSocket protocol
// ---------------------------------------------------------------------------

describe('worker WebSocket protocol', () => {
  let engine: Engine;
  let server: WeftServer;

  afterEach(async () => {
    await server?.stop();
    engine?.[Symbol.dispose]();
  });

  /** Open a WebSocket to the worker stream endpoint and wait for the connection. */
  async function connectWorker(
    wsServer: WeftServer,
    path = '/v1/tasks/default/stream',
  ): Promise<WebSocket> {
    const wsUrl = wsServer.url.replace('http://', 'ws://');
    const ws = new WebSocket(`${wsUrl}${path}`);

    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve());
      ws.addEventListener('error', () => reject(new Error('WebSocket connection failed')));
    });

    return ws;
  }

  /** Send a register message and wait for it to be processed. */
  async function registerWorker(
    ws: WebSocket,
    options: {
      workerId: string;
      activities: string[];
      concurrency?: number;
      queue?: string;
      deploymentName?: string;
      buildId?: string;
      runtimeVersion?: string;
      gitSha?: string;
      startedAt?: number;
      capabilities?: Record<string, unknown>;
    },
  ): Promise<void> {
    ws.send(
      JSON.stringify({
        type: 'register',
        protocolVersion: 2,
        workerId: options.workerId,
        activities: options.activities,
        concurrency: options.concurrency ?? 10,
        queue: options.queue ?? 'default',
        ...(options.deploymentName !== undefined ? { deploymentName: options.deploymentName } : {}),
        ...(options.buildId !== undefined ? { buildId: options.buildId } : {}),
        ...(options.runtimeVersion !== undefined ? { runtimeVersion: options.runtimeVersion } : {}),
        ...(options.gitSha !== undefined ? { gitSha: options.gitSha } : {}),
        ...(options.startedAt !== undefined ? { startedAt: options.startedAt } : {}),
        ...(options.capabilities !== undefined ? { capabilities: options.capabilities } : {}),
      }),
    );
    await waitForRealTimersForTesting(50);
  }

  it('tracks a worker after register message', async () => {
    engine = createEngine();
    server = serve({ engine, port: 0 });

    const ws = await connectWorker(server);
    await registerWorker(ws, {
      workerId: 'w1',
      activities: ['charge', 'ship'],
      concurrency: 5,
    });

    expect(server.registry.size).toBe(1);
    const workers = server.registry.getAll();
    expect(workers[0]?.id).toBe('w1');
    expect(workers[0]?.activities).toEqual(['charge', 'ship']);
    expect(workers[0]?.concurrency).toBe(5);

    ws.close();
    await waitForRealTimersForTesting(50);
  });

  it('records deployment identity and capabilities from worker registration', async () => {
    engine = createEngine();
    server = serve({ engine, port: 0 });

    const ws = await connectWorker(server);
    await registerWorker(ws, {
      workerId: 'identity-worker',
      activities: ['charge'],
      concurrency: 5,
      deploymentName: 'payments',
      buildId: 'build-2026-05-12',
      runtimeVersion: 'bun-1.2.13',
      gitSha: '0123456789abcdef',
      startedAt: 1_778_608_000_000,
      capabilities: { region: 'us-west', canary: true },
    });

    expect(server.registry.getWorker('identity-worker')).toMatchObject({
      id: 'identity-worker',
      deploymentName: 'payments',
      buildId: 'build-2026-05-12',
      runtimeVersion: 'bun-1.2.13',
      gitSha: '0123456789abcdef',
      startedAt: 1_778_608_000_000,
      capabilities: { region: 'us-west', canary: true },
    });

    ws.close();
    await waitForRealTimersForTesting(50);
  });

  it('sends registerAck after accepting a worker', async () => {
    engine = createEngine();
    server = serve({ engine, port: 0 });

    const ws = await connectWorker(server);
    const ackPromise = waitForWorkerMessage(
      ws,
      (message) => message['type'] === 'registerAck',
      'registerAck',
    );
    await registerWorker(ws, {
      workerId: 'w-register-ack',
      activities: ['charge'],
      concurrency: 5,
    });

    const ack = await ackPromise;
    expect(ack).toEqual({
      type: 'registerAck',
      protocolVersion: 2,
      workerId: 'w-register-ack',
      queue: 'default',
      activities: ['charge'],
      concurrency: 5,
    });

    ws.close();
    await waitForRealTimersForTesting(50);
  });

  it('rejects workers that omit protocolVersion', async () => {
    engine = createEngine();
    server = serve({ engine, port: 0 });

    const ws = await connectWorker(server);
    const errorPromise = waitForWorkerMessage(
      ws,
      (message) => message['type'] === 'registerError',
      'registerError',
    );
    ws.send(
      JSON.stringify({
        type: 'register',
        workerId: 'missing-version-worker',
        activities: ['charge'],
      }),
    );

    const error = await errorPromise;
    expect(error).toMatchObject({
      type: 'registerError',
      code: 'unsupported_protocol_version',
      supportedProtocolVersions: [2],
    });
    await waitFor(() => server.registry.size === 0, { label: 'missing-version worker rejected' });
    await waitForSocketClose(ws, 'missing-version socket close');
  });

  it('sends protocolError for invalid JSON, unknown messages, and pre-registration traffic', async () => {
    engine = createEngine();
    server = serve({ engine, port: 0 });

    const invalidJsonSocket = await connectWorker(server);
    const invalidJsonError = waitForWorkerMessage(
      invalidJsonSocket,
      (message) => message['type'] === 'protocolError',
      'invalid JSON protocolError',
    );
    invalidJsonSocket.send('not json at all');
    expect(await invalidJsonError).toMatchObject({
      type: 'protocolError',
      code: 'invalid_json',
    });
    await waitForSocketClose(invalidJsonSocket, 'invalid JSON socket close');

    const unknownSocket = await connectWorker(server);
    const unknownError = waitForWorkerMessage(
      unknownSocket,
      (message) => message['type'] === 'protocolError',
      'unknown message protocolError',
    );
    unknownSocket.send(JSON.stringify({ type: 'typo' }));
    expect(await unknownError).toMatchObject({
      type: 'protocolError',
      code: 'unknown_message_type',
    });
    await waitForSocketClose(unknownSocket, 'unknown message socket close');

    const preRegisterSocket = await connectWorker(server);
    const preRegisterError = waitForWorkerMessage(
      preRegisterSocket,
      (message) => message['type'] === 'protocolError',
      'pre-registration protocolError',
    );
    preRegisterSocket.send(JSON.stringify({ type: 'heartbeat', workerId: 'early' }));
    expect(await preRegisterError).toMatchObject({
      type: 'protocolError',
      code: 'registration_required',
    });
    await waitForSocketClose(preRegisterSocket, 'pre-registration socket close');
  });

  it('clamps worker concurrency to at least 1 when 0 is sent', async () => {
    engine = createEngine();
    server = serve({ engine, port: 0 });

    const ws = await connectWorker(server);
    await registerWorker(ws, { workerId: 'w-clamp-min', activities: ['charge'], concurrency: 0 });

    const worker = server.registry.getWorker('w-clamp-min');
    expect(worker?.concurrency).toBe(1);

    ws.close();
    await waitForRealTimersForTesting(50);
  });

  it('clamps worker concurrency to MAX_WORKER_CONCURRENCY (1000) when a huge value is sent', async () => {
    engine = createEngine();
    server = serve({ engine, port: 0 });

    const ws = await connectWorker(server);
    await registerWorker(ws, {
      workerId: 'w-clamp-max',
      activities: ['charge'],
      concurrency: 999_999,
    });

    const worker = server.registry.getWorker('w-clamp-max');
    expect(worker?.concurrency).toBe(1_000);

    ws.close();
    await waitForRealTimersForTesting(50);
  });

  it('unregisters a worker on WebSocket close', async () => {
    engine = createEngine();
    // Disable the reconnect grace period so the close handler unregisters
    // the worker synchronously, as this test asserts.
    server = serve({ engine, port: 0, workerReconnectGracePeriodMs: 0 });

    const ws = await connectWorker(server);
    await registerWorker(ws, { workerId: 'w2', activities: ['charge'] });

    expect(server.registry.size).toBe(1);

    ws.close();
    await waitForRealTimersForTesting(100);

    expect(server.registry.size).toBe(0);
  });

  it('updates heartbeat timestamp on heartbeat message', async () => {
    engine = createEngine();
    server = serve({ engine, port: 0 });

    const ws = await connectWorker(server);
    await registerWorker(ws, { workerId: 'w3', activities: ['charge'] });

    const before = server.registry.getAll()[0]?.lastHeartbeat ?? 0;
    await waitForRealTimersForTesting(50);

    ws.send(JSON.stringify({ type: 'heartbeat', workerId: 'w3' }));
    await waitForRealTimersForTesting(50);

    const after = server.registry.getAll()[0]?.lastHeartbeat ?? 0;
    expect(after).toBeGreaterThanOrEqual(before);

    ws.close();
    await waitForRealTimersForTesting(50);
  });

  it('records task lifecycle metadata and low-cardinality metrics for WebSocket dispatches', async () => {
    engine = createEngine();
    server = serve({ engine, port: 0 });

    const ws = await connectWorker(server);
    await registerWorker(ws, { workerId: 'w-diagnostics', activities: ['charge'], concurrency: 1 });

    ws.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data)) as { type: string; operationId?: string };
      if (message.type === 'task') {
        ws.send(
          JSON.stringify({
            type: 'taskResult',
            operationId: message.operationId,
            status: 'completed',
            value: 42,
          }),
        );
      }
    });

    await server.dispatchTask({
      operationId: 'diagnostic-ws-op',
      activityName: 'charge',
      input: null,
      workflowId: 'workflow-diagnostics',
    });

    await waitFor(
      async () => (await engine.storage.get(KEYS.operationResolved('diagnostic-ws-op'))) !== null,
      { label: 'diagnostic-ws-op to resolve' },
    );

    const resolved = decode(
      (await engine.storage.get(KEYS.operationResolved('diagnostic-ws-op')))!,
    ) as {
      workflowId?: string;
      activityName?: string;
      queue?: string;
      workerId?: string;
      firstQueuedAt?: number;
      lastDispatchedAt?: number;
      startedAt?: number;
      completedAt?: number;
      retryCount?: number;
      requeueCount?: number;
      resolutionReason?: string;
      queueLatencyMs?: number;
      executionLatencyMs?: number;
    };
    expect(resolved.workflowId).toBe('workflow-diagnostics');
    expect(resolved.activityName).toBe('charge');
    expect(resolved.queue).toBe('default');
    expect(resolved.workerId).toBe('w-diagnostics');
    expect(typeof resolved.firstQueuedAt).toBe('number');
    expect(typeof resolved.lastDispatchedAt).toBe('number');
    expect(typeof resolved.startedAt).toBe('number');
    expect(typeof resolved.completedAt).toBe('number');
    expect(resolved.retryCount).toBe(0);
    expect(resolved.requeueCount).toBe(0);
    expect(resolved.resolutionReason).toBe('completed');
    expect(typeof resolved.queueLatencyMs).toBe('number');
    expect(typeof resolved.executionLatencyMs).toBe('number');

    const metricsResponse = await fetch(`${server.url}/v1/metrics`);
    expect(metricsResponse.status).toBe(200);
    const metricsText = await metricsResponse.text();
    expect(metricsText).toContain('weft_task_queue_latency_count 1');
    expect(metricsText).toContain('weft_task_execution_latency_count 1');
    expect(metricsText).toContain('weft_worker_capacity_saturation 0');

    ws.close();
    await waitForRealTimersForTesting(50);
  });

  it('exposes WebSocket dispatch metrics through the server-owned system metrics endpoint', async () => {
    engine = createEngine();
    const apiKey = 'metrics-system-read-key';
    server = serve({
      engine,
      port: 0,
      auth: {
        apiKeys: [apiKey],
        defaultApiKeyScopes: ['system:read'],
        publicPaths: [
          '/v1/health',
          '/v1/metrics',
          '/.well-known/api-catalog',
          '/openapi.json',
          '/openrpc.json',
          '/asyncapi.json',
          '/v1/tasks/default/stream',
        ],
      },
    });

    const ws = await connectWorker(server);
    await registerWorker(ws, { workerId: 'w-owned-metrics', activities: ['charge'] });

    ws.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data)) as { type: string; operationId?: string };
      if (message.type === 'task') {
        ws.send(
          JSON.stringify({
            type: 'taskResult',
            operationId: message.operationId,
            status: 'completed',
            value: 42,
          }),
        );
      }
    });

    await server.dispatchTask({
      operationId: 'server-owned-metrics-op',
      activityName: 'charge',
      input: null,
      workflowId: 'workflow-server-owned-metrics',
    });

    await waitFor(
      async () =>
        (await engine.storage.get(KEYS.operationResolved('server-owned-metrics-op'))) !== null,
      { label: 'server-owned-metrics-op to resolve' },
    );

    const response = await fetch(`${server.url}/v1/metrics/json`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });

    expect(response.status).toBe(200);
    const snapshot = (await response.json()) as Record<string, { type?: string; value?: number }>;
    expect(snapshot[METRICS.taskQueueLatency.name]?.type).toBe('histogram');
    expect(snapshot[METRICS.taskExecutionLatency.name]?.type).toBe('histogram');
    expect(snapshot[METRICS.workerCapacitySaturation.name]).toEqual({ type: 'gauge', value: 0 });

    ws.close();
    await waitForRealTimersForTesting(50);
  });

  it('refreshes stale heartbeat metrics from runtime reconciliation scans', async () => {
    engine = createEngine();
    const now = Date.now();
    const staleInflightRecord: InflightRecord = {
      operationId: 'stale-heartbeat-metric-op',
      workerId: 'worker-stale-heartbeat',
      deadline: now + 60_000,
      activityName: 'charge',
      queue: 'default',
      input: null,
      attempt: 1,
      visibilityTimeout: 30_000,
      firstQueuedAt: now - 70_000,
      lastQueuedAt: now - 70_000,
      lastDispatchedAt: now - 65_000,
      startedAt: now - 65_000,
      lastHeartbeatAt: now - 61_000,
      retryCount: 0,
      requeueCount: 0,
    };
    await engine.storage.put(
      KEYS.operationInflight(staleInflightRecord.operationId),
      encode(staleInflightRecord),
    );

    server = serve({
      engine,
      port: 0,
      visibilityPollIntervalMs: 10,
    });

    await waitFor(
      async () => {
        const response = await fetch(`${server.url}/v1/metrics`);
        const text = await response.text();
        return text.includes('weft_task_stale_heartbeats 1');
      },
      { label: 'stale heartbeat metric to refresh', timeoutMs: 1000 },
    );
  });

  it('extends persisted task visibility deadlines on heartbeat', async () => {
    engine = createEngine();
    server = serve({ engine, port: 0 });

    const ws = await connectWorker(server);
    await registerWorker(ws, { workerId: 'w-heartbeat-extend', activities: ['charge'] });

    await server.dispatchTask({
      operationId: 'heartbeat-op',
      activityName: 'charge',
      input: null,
      visibilityTimeout: 200,
    });

    const before = decode((await engine.storage.get(KEYS.operationInflight('heartbeat-op')))!) as {
      deadline: number;
    };

    await waitForRealTimersForTesting(25);
    ws.send(JSON.stringify({ type: 'heartbeat', workerId: 'w-heartbeat-extend' }));
    await waitForRealTimersForTesting(75);

    const after = decode((await engine.storage.get(KEYS.operationInflight('heartbeat-op')))!) as {
      deadline: number;
    };

    expect(after.deadline).toBeGreaterThan(before.deadline);

    ws.close();
    await waitForRealTimersForTesting(50);
  });

  it('logs corrupt inflight records during heartbeat visibility extension', async () => {
    engine = createEngine();
    const storage = engine.storage as MemoryStorage;
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
    server = serve({ engine, port: 0 });

    try {
      const ws = await connectWorker(server);
      await registerWorker(ws, { workerId: 'w-heartbeat-corrupt', activities: ['charge'] });

      await server.dispatchTask({
        operationId: 'heartbeat-corrupt-op',
        activityName: 'charge',
        input: null,
        visibilityTimeout: 200,
      });
      await storage.put(KEYS.operationInflight('heartbeat-corrupt-op'), encode({ broken: true }));

      ws.send(JSON.stringify({ type: 'heartbeat', workerId: 'w-heartbeat-corrupt' }));
      await waitForRealTimersForTesting(100);

      expect(errorSpy).toHaveBeenCalledWith(
        '[weft] Corrupt inflight record for task "heartbeat-corrupt-op" during heartbeat — skipping visibility extension',
      );

      ws.close();
      await waitForRealTimersForTesting(50);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('logs heartbeat visibility persistence failures', async () => {
    engine = createEngine();
    const storage = engine.storage as MemoryStorage;
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
    const originalPut = storage.put.bind(storage);
    server = serve({ engine, port: 0 });

    const restorePut = overrideProperty(storage, 'put', (async (key: string, value: Uint8Array) => {
      if (key === KEYS.operationInflight('heartbeat-write-fail-op')) {
        throw new Error('heartbeat write failed');
      }
      await originalPut(key, value);
    }) as MemoryStorage['put']);

    try {
      const ws = await connectWorker(server);
      await registerWorker(ws, { workerId: 'w-heartbeat-write-fail', activities: ['charge'] });

      await server.dispatchTask({
        operationId: 'heartbeat-write-fail-op',
        activityName: 'charge',
        input: null,
        visibilityTimeout: 200,
      });

      ws.send(JSON.stringify({ type: 'heartbeat', workerId: 'w-heartbeat-write-fail' }));
      await waitFor(
        () =>
          errorSpy.mock.calls.some(
            ([message, error]) =>
              message ===
                '[weft] Failed to extend visibility for task "heartbeat-write-fail-op":' &&
              error instanceof Error &&
              error.message === 'heartbeat write failed',
          ),
        {
          label: 'heartbeat visibility persistence failure log',
        },
      );

      expect(errorSpy).toHaveBeenCalledWith(
        '[weft] Failed to extend visibility for task "heartbeat-write-fail-op":',
        expect.any(Error),
      );

      ws.close();
      await waitForRealTimersForTesting(50);
    } finally {
      restorePut();
      errorSpy.mockRestore();
    }
  });

  it('dispatches a task to the best available worker', async () => {
    engine = createEngine();
    server = serve({ engine, port: 0 });

    const ws = await connectWorker(server);
    const received: Array<{ type: string; operationId?: string; activityName?: string }> = [];

    ws.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data)) as {
        type: string;
        operationId?: string;
        activityName?: string;
      };
      if (message.type === 'task') received.push(message);
    });

    await registerWorker(ws, { workerId: 'w4', activities: ['charge'], concurrency: 5 });

    const dispatched = await server.dispatchTask({
      operationId: 'op-1',
      activityName: 'charge',
      input: { amount: 100 },
    });

    expect(dispatched).toBe(true);

    await waitForRealTimersForTesting(50);

    expect(received.length).toBe(1);
    expect(received[0]?.type).toBe('task');
    expect(received[0]?.operationId).toBe('op-1');
    expect(received[0]?.activityName).toBe('charge');

    ws.close();
    await waitForRealTimersForTesting(50);
  });

  it('routes new tasks away from draining workers while keeping in-flight tasks tracked', async () => {
    engine = createEngine();
    server = serve({ engine, port: 0 });

    const drainingSocket = await connectWorker(server);
    const activeSocket = await connectWorker(server);
    const receivedByActive: string[] = [];
    activeSocket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data)) as { type: string; operationId?: string };
      if (message.type === 'task' && message.operationId !== undefined) {
        receivedByActive.push(message.operationId);
      }
    });

    await registerWorker(drainingSocket, {
      workerId: 'draining-worker',
      activities: ['charge'],
      concurrency: 5,
    });
    await registerWorker(activeSocket, {
      workerId: 'active-worker',
      activities: ['charge'],
      concurrency: 5,
    });
    server.registry.assignTask('draining-worker', 'already-running', 30_000);

    server.registry.markWorkerDraining('draining-worker', {
      reason: 'rolling deploy',
      updatedAt: 1000,
    });

    const dispatched = await server.dispatchTask({
      operationId: 'new-work',
      activityName: 'charge',
      input: null,
    });

    expect(dispatched).toBe(true);
    await waitFor(() => receivedByActive.includes('new-work'), {
      label: 'new work routed to active worker',
    });
    expect(server.registry.isAssigned('already-running')).toBe(true);
    expect(server.registry.getTask('already-running')?.workerId).toBe('draining-worker');
    expect(server.registry.getTask('new-work')?.workerId).toBe('active-worker');

    drainingSocket.close();
    activeSocket.close();
    await waitForRealTimersForTesting(50);
  });

  it('falls back to long-poll when every matching WebSocket worker is draining', async () => {
    engine = createEngine();
    server = serve({ engine, port: 0 });

    const ws = await connectWorker(server);
    await registerWorker(ws, { workerId: 'drain-only-worker', activities: ['charge'] });
    server.registry.markWorkerDraining('drain-only-worker', { updatedAt: 1000 });

    const dispatched = await server.dispatchTask({
      operationId: 'queued-after-drain',
      activityName: 'charge',
      input: null,
    });

    expect(dispatched).toBe(true);
    expect(server.taskQueue.pendingCount('default')).toBe(1);

    ws.close();
    await waitForRealTimersForTesting(50);
  });

  it('queues task for long-poll workers when no WebSocket worker is available', async () => {
    engine = createEngine();
    server = serve({ engine, port: 0 });

    const dispatched = await server.dispatchTask({
      operationId: 'op-2',
      activityName: 'charge',
      input: null,
    });

    // With the long-poll fallback, tasks are queued instead of rejected
    expect(dispatched).toBe(true);
    expect(server.taskQueue.pendingCount('default')).toBe(1);
  });

  it('increments in-flight count on dispatch and decrements on task result', async () => {
    engine = createEngine();
    server = serve({ engine, port: 0 });

    const ws = await connectWorker(server);

    // Auto-respond to tasks with a completed result
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(String(event.data)) as { type: string; operationId?: string };
      if (msg.type === 'task') {
        ws.send(
          JSON.stringify({
            type: 'taskResult',
            operationId: msg.operationId,
            status: 'completed',
            value: 42,
          }),
        );
      }
    });

    await registerWorker(ws, { workerId: 'w5', activities: ['compute'], concurrency: 5 });

    await server.dispatchTask({ operationId: 'op-3', activityName: 'compute', input: null });

    // Right after dispatch, in-flight should be 1
    expect(server.registry.getAll()[0]?.inFlight).toBe(1);

    // Wait for the task result to round-trip and decrement the in-flight count.
    // Poll the actual condition instead of a fixed sleep so the assertion stays
    // stable under load rather than racing a hardcoded delay.
    await waitFor(() => server.registry.getAll()[0]?.inFlight === 0, {
      label: 'in-flight count returns to 0',
    });

    expect(server.registry.getAll()[0]?.inFlight).toBe(0);

    ws.close();
    await waitForRealTimersForTesting(50);
  });

  it('handles invalid JSON messages without crashing', async () => {
    engine = createEngine();
    server = serve({ engine, port: 0 });

    const ws = await connectWorker(server);

    const protocolError = waitForWorkerMessage(
      ws,
      (message) => message['type'] === 'protocolError',
      'invalid JSON protocolError',
    );
    ws.send('not json at all');

    expect(await protocolError).toMatchObject({
      type: 'protocolError',
      code: 'invalid_json',
    });
    await waitForSocketClose(ws, 'invalid JSON worker socket close');

    // Server should still be running after rejecting the malformed worker.
    const response = await fetch(`${server.url}/v1/health`);
    expect(response.status).toBe(200);
  });

  it('ignores worker protocol messages on non-worker paths', async () => {
    engine = createEngine();
    server = serve({ engine, port: 0 });

    // Connect to observation endpoint, not worker stream
    const ws = await connectWorker(server, '/v1/workflows/test-wf/watch');

    ws.send(
      JSON.stringify({
        type: 'register',
        protocolVersion: 2,
        workerId: 'rogue',
        activities: ['charge'],
        concurrency: 5,
      }),
    );
    await waitForRealTimersForTesting(50);

    // Registry should be empty — register messages are only processed on worker paths
    expect(server.registry.size).toBe(0);

    ws.close();
    await waitForRealTimersForTesting(50);
  });

  it('supports multiple workers and routes to least-loaded', async () => {
    engine = createEngine();
    server = serve({ engine, port: 0 });

    const ws1 = await connectWorker(server);
    const ws2 = await connectWorker(server);
    const received1: Array<{ type: string }> = [];
    const received2: Array<{ type: string }> = [];

    ws1.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data)) as { type: string };
      if (message.type === 'task') received1.push(message);
    });
    ws2.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data)) as { type: string };
      if (message.type === 'task') received2.push(message);
    });

    await registerWorker(ws1, { workerId: 'w-a', activities: ['charge'], concurrency: 5 });
    await registerWorker(ws2, { workerId: 'w-b', activities: ['charge'], concurrency: 5 });

    // Dispatch two tasks — both workers start at 0 in-flight, so the first
    // goes to whichever findWorker returns first, and the second should go
    // to the other (least-loaded).
    await server.dispatchTask({ operationId: 'op-a', activityName: 'charge', input: null });
    await server.dispatchTask({ operationId: 'op-b', activityName: 'charge', input: null });

    await waitForRealTimersForTesting(50);

    // Each worker should have received exactly one task
    expect(received1.length).toBe(1);
    expect(received2.length).toBe(1);

    ws1.close();
    ws2.close();
    await waitForRealTimersForTesting(50);
  });

  it('routes via fair-share when routingPolicy is fair-share and fairShareKey is dispatched', async () => {
    engine = createEngine();
    server = serve({ engine, port: 0, routingPolicy: 'fair-share' });

    const sockets: WebSocket[] = [];
    const receivedByWorker = new Map<string, Array<{ operationId: string }>>();

    for (let index = 0; index < 3; index += 1) {
      const workerId = `fair-share-worker-${index}`;
      receivedByWorker.set(workerId, []);

      const ws = await connectWorker(server);
      ws.addEventListener('message', (event) => {
        const message = JSON.parse(String(event.data)) as {
          type: string;
          operationId?: string;
        };
        if (message.type === 'task' && message.operationId !== undefined) {
          receivedByWorker.get(workerId)!.push({ operationId: message.operationId });
        }
      });
      await registerWorker(ws, { workerId, activities: ['runAgent'], concurrency: 10 });
      sockets.push(ws);
    }

    // Dispatch six tasks all under the same fair-share key. fair-share should
    // spread them evenly across the three workers — 2 per worker. If
    // routingPolicy were silently falling back to least-loaded, the first
    // dispatch would still tiebreak by id and the spread would happen by
    // accident. So we also dispatch a second key (`tenant-beta`) to prove the
    // *per-key* counters survive the round trip and influence the next
    // assignment for that key independently of the alpha tasks.
    for (let index = 0; index < 6; index += 1) {
      const dispatched = await server.dispatchTask({
        operationId: `alpha-${index}`,
        activityName: 'runAgent',
        input: null,
        fairShareKey: 'tenant-alpha',
      });
      expect(dispatched).toBe(true);
    }

    await waitForRealTimersForTesting(50);

    // Every worker received exactly two alpha tasks.
    for (const [workerId, tasks] of receivedByWorker) {
      expect(tasks).toHaveLength(2);
      // Sanity check: every received op id was an alpha task assigned to this
      // worker.
      for (const task of tasks) {
        expect(task.operationId.startsWith('alpha-')).toBe(true);
        const inflight = server.registry.getTask(task.operationId);
        expect(inflight?.workerId).toBe(workerId);
      }
    }

    // Now dispatch a single tenant-beta task. The least-loaded fallback would
    // pick the first worker by id (all three carry 2 alpha tasks), but the
    // per-key fair-share counter for beta is 0 everywhere — fair-share's
    // tiebreak by id then puts it on `fair-share-worker-0`, which is what we
    // assert. The point is not the exact id, but that the *count of beta
    // tasks per worker* is what was used, not the alpha load.
    const dispatchedBeta = await server.dispatchTask({
      operationId: 'beta-1',
      activityName: 'runAgent',
      input: null,
      fairShareKey: 'tenant-beta',
    });
    expect(dispatchedBeta).toBe(true);
    await waitForRealTimersForTesting(50);

    // Exactly one worker picked up beta-1 — and the worker chosen had a
    // per-beta-key count of 0 before this dispatch (which is true for any of
    // the three, since all had only alpha load before).
    let betaWorkerId: string | undefined;
    for (const [workerId, tasks] of receivedByWorker) {
      const betaTasks = tasks.filter((task) => task.operationId === 'beta-1');
      if (betaTasks.length > 0) {
        expect(betaWorkerId).toBeUndefined();
        betaWorkerId = workerId;
      }
    }
    expect(betaWorkerId).toBeDefined();

    for (const ws of sockets) {
      ws.close();
    }
    await waitForRealTimersForTesting(50);
  });

  it('falls back to long-poll queue when WebSocket workers are at capacity', async () => {
    engine = createEngine();
    server = serve({ engine, port: 0 });

    const ws = await connectWorker(server);
    await registerWorker(ws, { workerId: 'w-cap', activities: ['compute'], concurrency: 1 });

    // First dispatch should go to the WebSocket worker
    const first = await server.dispatchTask({
      operationId: 'cap-1',
      activityName: 'compute',
      input: null,
    });
    expect(first).toBe(true);
    expect(server.registry.getWorker('w-cap')?.inFlight).toBe(1);

    // Second dispatch — worker is at capacity (1/1), should fall to long-poll queue
    const second = await server.dispatchTask({
      operationId: 'cap-2',
      activityName: 'compute',
      input: null,
    });
    expect(second).toBe(true);
    expect(server.taskQueue.pendingCount('default')).toBe(1);

    ws.close();
    await waitForRealTimersForTesting(50);
  });

  it('worker capacity recovers after task completion and accepts new tasks', async () => {
    engine = createEngine();
    server = serve({ engine, port: 0 });

    const ws = await connectWorker(server);
    const received: Array<{ type: string; operationId?: string }> = [];

    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(String(event.data)) as { type: string; operationId?: string };
      received.push(msg);
      // Complete tasks immediately
      if (msg.type === 'task') {
        ws.send(
          JSON.stringify({
            type: 'taskResult',
            operationId: msg.operationId,
            status: 'completed',
            value: null,
          }),
        );
      }
    });

    await registerWorker(ws, { workerId: 'w-recover', activities: ['compute'], concurrency: 1 });

    // Dispatch first task
    await server.dispatchTask({ operationId: 'r-1', activityName: 'compute', input: null });
    expect(server.registry.getWorker('w-recover')?.inFlight).toBe(1);

    // Wait for task result to arrive and decrement inFlight
    await waitForRealTimersForTesting(100);
    expect(server.registry.getWorker('w-recover')?.inFlight).toBe(0);

    // Dispatch second task — worker should accept it since capacity recovered
    await server.dispatchTask({ operationId: 'r-2', activityName: 'compute', input: null });
    expect(server.registry.getWorker('w-recover')?.inFlight).toBe(1);

    await waitForRealTimersForTesting(100);
    expect(server.registry.getWorker('w-recover')?.inFlight).toBe(0);

    // Both tasks were dispatched directly to the WebSocket worker (not queued)
    const taskMessages = received.filter((m) => m.type === 'task');
    expect(taskMessages.length).toBe(2);
    expect(server.taskQueue.pendingCount('default')).toBe(0);

    ws.close();
    await waitForRealTimersForTesting(50);
  });

  it('tracks available capacity as concurrency minus inFlight through dispatch cycle', async () => {
    engine = createEngine();
    server = serve({ engine, port: 0 });

    const ws = await connectWorker(server);
    await registerWorker(ws, { workerId: 'w-track', activities: ['compute'], concurrency: 3 });

    const worker = () => server.registry.getWorker('w-track')!;

    // Initial: full capacity
    expect(worker().concurrency - worker().inFlight).toBe(3);

    // Dispatch 2 tasks
    await server.dispatchTask({ operationId: 't-1', activityName: 'compute', input: null });
    await server.dispatchTask({ operationId: 't-2', activityName: 'compute', input: null });
    expect(worker().concurrency - worker().inFlight).toBe(1);

    // Complete one task
    ws.send(
      JSON.stringify({ type: 'taskResult', operationId: 't-1', status: 'completed', value: null }),
    );
    await waitForRealTimersForTesting(50);
    expect(worker().concurrency - worker().inFlight).toBe(2);

    // Complete the other
    ws.send(
      JSON.stringify({ type: 'taskResult', operationId: 't-2', status: 'completed', value: null }),
    );
    await waitForRealTimersForTesting(50);
    expect(worker().concurrency - worker().inFlight).toBe(3);

    ws.close();
    await waitForRealTimersForTesting(50);
  });

  it('integrates with RemoteWorker end-to-end', async () => {
    engine = createEngine();
    // Disable the reconnect grace period so the disconnect at the end of the
    // test unregisters the worker synchronously.
    server = serve({ engine, port: 0, workerReconnectGracePeriodMs: 0 });

    const { RemoteWorker } = await import('../worker/index.ts');

    const worker = new RemoteWorker({
      serverUrl: `ws://localhost:${server.port}/v1/tasks/default/stream`,
      workerId: 'remote-1',
      activities: {
        greet: async (input: unknown) => `Hello, ${String(input)}!`,
      },
      concurrency: 3,
    });

    await worker.connect();
    await waitForRealTimersForTesting(50);

    // Server should have registered the worker
    expect(server.registry.size).toBe(1);
    expect(server.registry.getAll()[0]?.id).toBe('remote-1');
    expect(server.registry.getAll()[0]?.activities).toEqual(['greet']);
    expect(server.registry.getAll()[0]?.concurrency).toBe(3);

    // Dispatch a task and verify the worker processes it
    const dispatched = await server.dispatchTask({
      operationId: 'e2e-op-1',
      activityName: 'greet',
      input: 'World',
    });
    expect(dispatched).toBe(true);

    // Wait for the worker to process the task and send the result
    await waitForRealTimersForTesting(200);

    // in-flight should be back to 0 after the result is received
    expect(server.registry.getAll()[0]?.inFlight).toBe(0);

    await worker.disconnect();
    await waitForRealTimersForTesting(50);

    // Worker should be unregistered after disconnect
    expect(server.registry.size).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Sticky routing
  // -------------------------------------------------------------------------

  it('sticky dispatch prefers the worker that last handled a task for the same workflow', async () => {
    engine = createEngine();
    server = serve({ engine, port: 0 });

    const ws1 = await connectWorker(server);
    const ws2 = await connectWorker(server);
    const received1: Array<{ type: string; operationId?: string }> = [];
    const received2: Array<{ type: string; operationId?: string }> = [];

    ws1.addEventListener('message', (event) => {
      const msg = JSON.parse(String(event.data)) as { type: string; operationId?: string };
      received1.push(msg);
      if (msg.type === 'task') {
        ws1.send(
          JSON.stringify({
            type: 'taskResult',
            operationId: msg.operationId,
            status: 'completed',
            value: null,
          }),
        );
      }
    });
    ws2.addEventListener('message', (event) => {
      const msg = JSON.parse(String(event.data)) as { type: string; operationId?: string };
      received2.push(msg);
      if (msg.type === 'task') {
        ws2.send(
          JSON.stringify({
            type: 'taskResult',
            operationId: msg.operationId,
            status: 'completed',
            value: null,
          }),
        );
      }
    });

    await registerWorker(ws1, { workerId: 'sticky-w1', activities: ['compute'], concurrency: 5 });
    await registerWorker(ws2, { workerId: 'sticky-w2', activities: ['compute'], concurrency: 5 });

    // First dispatch with workflowId — goes to whichever worker (least-loaded, both at 0).
    await server.dispatchTask({
      operationId: 'sticky-op-1',
      activityName: 'compute',
      input: null,
      workflowId: 'wf-sticky-1',
    });
    await waitForRealTimersForTesting(100);

    // Determine which worker handled the first task.
    const firstWorker = received1.some((m) => m.operationId === 'sticky-op-1')
      ? 'sticky-w1'
      : 'sticky-w2';
    const firstReceived = firstWorker === 'sticky-w1' ? received1 : received2;

    // Second dispatch with sticky: true — should prefer the same worker.
    await server.dispatchTask({
      operationId: 'sticky-op-2',
      activityName: 'compute',
      input: null,
      workflowId: 'wf-sticky-1',
      sticky: true,
    });
    await waitForRealTimersForTesting(100);

    // The same worker that handled op-1 should also get op-2.
    expect(firstReceived.some((m) => m.operationId === 'sticky-op-2')).toBe(true);

    ws1.close();
    ws2.close();
    await waitForRealTimersForTesting(50);
  });

  it('sticky dispatch falls back to least-loaded when preferred worker is at capacity', async () => {
    engine = createEngine();
    server = serve({ engine, port: 0 });

    const ws1 = await connectWorker(server);
    const ws2 = await connectWorker(server);
    const received2: Array<{ type: string; operationId?: string }> = [];

    // Worker 1 does NOT auto-complete tasks (stays at capacity)
    ws2.addEventListener('message', (event) => {
      received2.push(JSON.parse(String(event.data)) as { type: string; operationId?: string });
    });

    await registerWorker(ws1, { workerId: 'cap-w1', activities: ['compute'], concurrency: 1 });
    await registerWorker(ws2, { workerId: 'cap-w2', activities: ['compute'], concurrency: 5 });

    // First dispatch establishes affinity with w1.
    await server.dispatchTask({
      operationId: 'cap-op-1',
      activityName: 'compute',
      input: null,
      workflowId: 'wf-cap',
    });
    await waitForRealTimersForTesting(50);

    // w1 is now at capacity (1/1). Sticky dispatch should fall back to w2.
    await server.dispatchTask({
      operationId: 'cap-op-2',
      activityName: 'compute',
      input: null,
      workflowId: 'wf-cap',
      sticky: true,
    });
    await waitForRealTimersForTesting(50);

    expect(received2.some((m) => m.operationId === 'cap-op-2')).toBe(true);

    ws1.close();
    ws2.close();
    await waitForRealTimersForTesting(50);
  });

  it('sticky dispatch without workflowId uses normal least-loaded routing', async () => {
    engine = createEngine();
    server = serve({ engine, port: 0 });

    const ws1 = await connectWorker(server);
    const ws2 = await connectWorker(server);

    await registerWorker(ws1, { workerId: 'noid-w1', activities: ['compute'], concurrency: 5 });
    await registerWorker(ws2, { workerId: 'noid-w2', activities: ['compute'], concurrency: 5 });

    // Dispatch with sticky: true but no workflowId — should not crash, just use normal routing.
    const dispatched = await server.dispatchTask({
      operationId: 'noid-op-1',
      activityName: 'compute',
      input: null,
      sticky: true,
    });
    expect(dispatched).toBe(true);

    ws1.close();
    ws2.close();
    await waitForRealTimersForTesting(50);
  });
});

// ---------------------------------------------------------------------------
// Queue-aware worker stream (WS /v1/tasks/:queue/stream)
// ---------------------------------------------------------------------------

describe('queue-aware worker stream', () => {
  let engine: Engine;
  let server: WeftServer;

  afterEach(async () => {
    await server?.stop();
    engine?.[Symbol.dispose]();
  });

  /** Open a WebSocket to a specific queue's worker stream endpoint. */
  async function connectWorker(wsServer: WeftServer, queue: string): Promise<WebSocket> {
    const wsUrl = wsServer.url.replace('http://', 'ws://');
    const ws = new WebSocket(`${wsUrl}/v1/tasks/${encodeURIComponent(queue)}/stream`);

    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve());
      ws.addEventListener('error', () => reject(new Error('WebSocket connection failed')));
    });

    return ws;
  }

  /** Send a register message and wait for it to be processed. */
  async function registerWorker(
    ws: WebSocket,
    options: { workerId: string; activities: string[]; concurrency?: number },
  ): Promise<void> {
    ws.send(
      JSON.stringify({
        type: 'register',
        protocolVersion: 2,
        workerId: options.workerId,
        activities: options.activities,
        concurrency: options.concurrency ?? 10,
      }),
    );
    await waitForRealTimersForTesting(50);
  }

  it('extracts queue name from the connection URL', async () => {
    engine = createEngine();
    server = serve({ engine, port: 0 });

    const ws = await connectWorker(server, 'billing');
    await registerWorker(ws, { workerId: 'billing-w1', activities: ['charge'] });

    const worker = server.registry.getAll()[0]!;
    expect(worker.queue).toBe('billing');

    ws.close();
    await waitForRealTimersForTesting(50);
  });

  it('dispatches tasks only to workers on the matching queue', async () => {
    engine = createEngine();
    server = serve({ engine, port: 0 });

    const billingWs = await connectWorker(server, 'billing');
    const shippingWs = await connectWorker(server, 'shipping');

    const billingReceived: Array<{ type: string; operationId?: string }> = [];
    const shippingReceived: Array<{ type: string; operationId?: string }> = [];

    billingWs.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data)) as { type: string; operationId?: string };
      if (message.type === 'task') billingReceived.push(message);
    });
    shippingWs.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data)) as { type: string; operationId?: string };
      if (message.type === 'task') shippingReceived.push(message);
    });

    await registerWorker(billingWs, { workerId: 'billing-w1', activities: ['charge'] });
    await registerWorker(shippingWs, { workerId: 'shipping-w1', activities: ['charge'] });

    // Dispatch to billing queue
    await server.dispatchTask({
      operationId: 'billing-op',
      activityName: 'charge',
      input: { amount: 100 },
      queue: 'billing',
    });

    await waitForRealTimersForTesting(50);

    // Only the billing worker should receive the task
    expect(billingReceived.length).toBe(1);
    expect(billingReceived[0]?.operationId).toBe('billing-op');
    expect(shippingReceived.length).toBe(0);

    billingWs.close();
    shippingWs.close();
    await waitForRealTimersForTesting(50);
  });

  it('falls back to long-poll queue with the correct queue name', async () => {
    engine = createEngine();
    server = serve({ engine, port: 0 });

    // Dispatch to a specific queue with no WebSocket workers
    await server.dispatchTask({
      operationId: 'queued-op',
      activityName: 'charge',
      input: null,
      queue: 'billing',
    });

    // Task should be in the 'billing' queue, not 'default'
    expect(server.taskQueue.pendingCount('billing')).toBe(1);
    expect(server.taskQueue.pendingCount('default')).toBe(0);
  });

  it('defaults to the "default" queue when no queue is specified in dispatch', async () => {
    engine = createEngine();
    server = serve({ engine, port: 0 });

    const ws = await connectWorker(server, 'default');
    const received: Array<{ type: string; operationId?: string }> = [];

    ws.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data)) as { type: string; operationId?: string };
      if (message.type === 'task') received.push(message);
    });

    await registerWorker(ws, { workerId: 'default-w1', activities: ['charge'] });

    // Dispatch without specifying queue — should default to 'default'
    await server.dispatchTask({
      operationId: 'default-op',
      activityName: 'charge',
      input: null,
    });

    await waitForRealTimersForTesting(50);

    expect(received.length).toBe(1);
    expect(received[0]?.operationId).toBe('default-op');

    ws.close();
    await waitForRealTimersForTesting(50);
  });

  it('workers on different queues are isolated from each other', async () => {
    engine = createEngine();
    server = serve({ engine, port: 0 });

    const billingWs = await connectWorker(server, 'billing');
    const defaultWs = await connectWorker(server, 'default');

    const billingReceived: Array<{ type: string }> = [];
    const defaultReceived: Array<{ type: string }> = [];

    billingWs.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data)) as { type: string };
      if (message.type === 'task') billingReceived.push(message);
    });
    defaultWs.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data)) as { type: string };
      if (message.type === 'task') defaultReceived.push(message);
    });

    await registerWorker(billingWs, { workerId: 'billing-w1', activities: ['charge'] });
    await registerWorker(defaultWs, { workerId: 'default-w1', activities: ['charge'] });

    // Dispatch to default queue — should not reach billing worker
    await server.dispatchTask({
      operationId: 'default-only',
      activityName: 'charge',
      input: null,
    });

    await waitForRealTimersForTesting(50);

    expect(defaultReceived.length).toBe(1);
    expect(billingReceived.length).toBe(0);

    billingWs.close();
    defaultWs.close();
    await waitForRealTimersForTesting(50);
  });

  it('integrates with RemoteWorker on a custom queue', async () => {
    engine = createEngine();
    server = serve({ engine, port: 0 });

    const { RemoteWorker } = await import('../worker/index.ts');

    const worker = new RemoteWorker({
      serverUrl: `ws://localhost:${server.port}/v1/tasks/billing/stream`,
      workerId: 'billing-remote',
      activities: {
        charge: async (input: unknown) => ({ charged: input }),
      },
      concurrency: 3,
      queue: 'billing',
    });

    await worker.connect();
    await waitForRealTimersForTesting(50);

    // Worker should be registered on the billing queue
    expect(server.registry.size).toBe(1);
    const registered = server.registry.getAll()[0]!;
    expect(registered.id).toBe('billing-remote');
    expect(registered.queue).toBe('billing');

    // Dispatch to the billing queue
    const dispatched = await server.dispatchTask({
      operationId: 'billing-e2e',
      activityName: 'charge',
      input: 42,
      queue: 'billing',
    });
    expect(dispatched).toBe(true);

    await waitForRealTimersForTesting(200);

    // Task should be completed
    expect(registered.inFlight).toBe(0);

    await worker.disconnect();
    await waitForRealTimersForTesting(50);
  });
});

// ---------------------------------------------------------------------------
// Token streaming WebSocket
// ---------------------------------------------------------------------------

describe('token streaming WebSocket (WS /v1/workflows/:id/stream)', () => {
  let engine: Engine;
  let server: WeftServer;

  afterEach(async () => {
    await server?.stop();
    engine?.[Symbol.dispose]();
  });

  /** Open a WebSocket to the token stream endpoint and wait for the connection. */
  async function connectStream(
    wsServer: WeftServer,
    workflowId: string,
    options?: { resumeFrom?: number },
  ): Promise<WebSocket> {
    const wsUrl = wsServer.url.replace('http://', 'ws://');
    const url = new URL(`${wsUrl}/v1/workflows/${encodeURIComponent(workflowId)}/stream`);
    if (options?.resumeFrom !== undefined) {
      url.searchParams.set('resumeFrom', String(options.resumeFrom));
    }
    const ws = new WebSocket(url.toString());

    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve());
      ws.addEventListener('error', () => reject(new Error('WebSocket connection failed')));
    });

    return ws;
  }

  async function expectStreamConnectionFailure(
    wsServer: WeftServer,
    workflowId: string,
    resumeFrom: string,
  ): Promise<void> {
    const wsUrl = wsServer.url.replace('http://', 'ws://');
    const url = new URL(`${wsUrl}/v1/workflows/${encodeURIComponent(workflowId)}/stream`);
    url.searchParams.set('resumeFrom', resumeFrom);

    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(url.toString());
      const timeout = setTimeout(() => reject(new Error('Expected WebSocket failure')), 1_000);
      const finish = (): void => {
        clearTimeout(timeout);
        resolve();
      };

      ws.addEventListener('open', () => {
        clearTimeout(timeout);
        ws.close();
        reject(new Error(`Unexpectedly connected with resumeFrom=${resumeFrom}`));
      });
      ws.addEventListener('error', finish, { once: true });
      ws.addEventListener('close', finish, { once: true });
    });
  }

  async function connectWatch(wsServer: WeftServer, workflowId: string): Promise<WebSocket> {
    const wsUrl = wsServer.url.replace('http://', 'ws://');
    const ws = new WebSocket(`${wsUrl}/v1/workflows/${encodeURIComponent(workflowId)}/watch`);

    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve());
      ws.addEventListener('error', () => reject(new Error('WebSocket connection failed')));
    });

    return ws;
  }

  /** Collect messages received on a WebSocket. */
  function collectMessages(ws: WebSocket): Array<{ type: string; [key: string]: unknown }> {
    const messages: Array<{ type: string; [key: string]: unknown }> = [];
    ws.addEventListener('message', (event) => {
      messages.push(JSON.parse(String(event.data)));
    });
    return messages;
  }

  it('accepts a WebSocket connection on /v1/workflows/:id/stream', async () => {
    engine = createEngine();
    server = serve({ engine, port: 0 });

    const ws = await connectStream(server, 'test-wf');
    expect(ws.readyState).toBe(WebSocket.OPEN);

    ws.close();
    await waitForRealTimersForTesting(50);
  });

  it('receives live token events through the stream connection', async () => {
    engine = createEngine();
    server = serve({ engine, port: 0 });

    // Start a workflow so events have a target
    const startResponse = await fetch(`${server.url}/v1/workflows`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'echo', input: 'hello' }),
    });
    const { id } = (await startResponse.json()) as { id: string };
    await flush();

    const ws = await connectStream(server, id);
    const messages = collectMessages(ws);
    await waitForRealTimersForTesting(50);

    // Dispatch token events directly on the engine
    engine.dispatchEvent(new TokenEvent(id, 'Hello', 'gpt-4'));
    engine.dispatchEvent(new TokenEvent(id, ' world', 'gpt-4'));
    await waitForRealTimersForTesting(200);

    // Should have received the two token events
    const tokenMessages = messages.filter((m) => m.type === TokenEvent.type);
    expect(tokenMessages.length).toBe(2);
    expect(tokenMessages[0]?.['data']).toMatchObject({ token: 'Hello', model: 'gpt-4' });
    expect(tokenMessages[1]?.['data']).toMatchObject({ token: ' world', model: 'gpt-4' });
    expect(typeof tokenMessages[0]?.['sequence']).toBe('number');
    expect(typeof tokenMessages[1]?.['sequence']).toBe('number');

    ws.close();
    await waitForRealTimersForTesting(50);
  });

  it('receives live token events through the stream connection for workflow ids that require encoding', async () => {
    engine = createEngine();
    server = serve({ engine, port: 0 });

    const workflowId = 'wf:stream/with spaces';
    const ws = await connectStream(server, workflowId);
    const messages = collectMessages(ws);
    await waitForRealTimersForTesting(50);

    engine.dispatchEvent(new TokenEvent(workflowId, 'encoded-live', 'gpt-4'));
    await waitForRealTimersForTesting(200);

    const tokenMessages = messages.filter((message) => message.type === TokenEvent.type);
    expect(tokenMessages).toHaveLength(1);
    expect(tokenMessages[0]?.['data']).toMatchObject({ token: 'encoded-live', model: 'gpt-4' });

    ws.close();
    await waitForRealTimersForTesting(50);
  });

  it('receives live watch events for workflow ids that require encoding', async () => {
    engine = createEngine();
    server = serve({ engine, port: 0 });

    const workflowId = 'wf:watch/with spaces';
    const ws = await connectWatch(server, workflowId);
    const messages = collectMessages(ws);
    await waitForRealTimersForTesting(50);

    engine.dispatchEvent(new WorkflowCompletedEvent(workflowId, 'encoded-watch', 1));
    await waitForRealTimersForTesting(200);

    const completionMessages = messages.filter(
      (message) => message.type === WorkflowCompletedEvent.type,
    );
    expect(completionMessages).toHaveLength(1);
    expect(completionMessages[0]?.['data']).toMatchObject({
      workflowId,
      result: 'encoded-watch',
    });

    ws.close();
    await waitForRealTimersForTesting(50);
  });

  it('only receives token events for the subscribed workflow', async () => {
    engine = createEngine();
    server = serve({ engine, port: 0 });

    const ws = await connectStream(server, 'wf-a');
    const messages = collectMessages(ws);
    await waitForRealTimersForTesting(50);

    // Dispatch token events for two different workflows
    engine.dispatchEvent(new TokenEvent('wf-a', 'for-a', 'gpt-4'));
    engine.dispatchEvent(new TokenEvent('wf-b', 'for-b', 'gpt-4'));
    await waitForRealTimersForTesting(200);

    // Should only see the event for wf-a
    const tokenMessages = messages.filter((m) => m.type === TokenEvent.type);
    expect(tokenMessages.length).toBe(1);
    expect(tokenMessages[0]?.['data']).toMatchObject({ token: 'for-a' });

    ws.close();
    await waitForRealTimersForTesting(50);
  });

  it('replays existing token events on connect', async () => {
    engine = createEngine();
    server = serve({ engine, port: 0 });

    // Dispatch token events before a client connects
    engine.dispatchEvent(new TokenEvent('wf-replay', 'first', 'gpt-4'));
    engine.dispatchEvent(new TokenEvent('wf-replay', 'second', 'gpt-4'));
    await waitForRealTimersForTesting(200);

    // Now connect — client should receive replay of existing token events
    const ws = await connectStream(server, 'wf-replay');
    const messages = collectMessages(ws);
    await waitForRealTimersForTesting(200);

    const replayMessages = messages.filter((message) => message.type === TokenEvent.type);
    expect(replayMessages.length).toBeGreaterThanOrEqual(2);

    const replayedTokens = replayMessages.map(
      (message) => (message['data'] as Record<string, unknown>)?.['token'],
    );
    expect(replayedTokens).toContain('first');
    expect(replayedTokens).toContain('second');
    expect(replayMessages.map((message) => message['sequence'])).toEqual([0, 1]);

    ws.close();
    await waitForRealTimersForTesting(50);
  });

  it('replays existing token events on connect for workflow ids that require encoding', async () => {
    engine = createEngine();
    server = serve({ engine, port: 0 });

    const workflowId = 'wf:replay/with spaces';
    engine.dispatchEvent(new TokenEvent(workflowId, 'encoded', 'gpt-4'));
    await waitForRealTimersForTesting(200);

    const ws = await connectStream(server, workflowId);
    const messages = collectMessages(ws);
    await waitForRealTimersForTesting(200);

    const replayMessages = messages.filter((message) => message.type === TokenEvent.type);
    const replayedTokens = replayMessages.map(
      (message) => (message['data'] as Record<string, unknown>)?.['token'],
    );

    expect(replayedTokens).toContain('encoded');

    ws.close();
    await waitForRealTimersForTesting(50);
  });

  it('rejects malformed encoded workflow stream paths without crashing the server', async () => {
    engine = createEngine();
    server = serve({ engine, port: 0 });

    const wsUrl = server.url.replace('http://', 'ws://');
    const failed = await new Promise<boolean>((resolve, reject) => {
      const ws = new WebSocket(`${wsUrl}/v1/workflows/%E0%A4%A/stream`);
      const timeout = setTimeout(() => reject(new Error('Expected WebSocket failure')), 1_000);
      const finish = (): void => {
        clearTimeout(timeout);
        resolve(true);
      };

      ws.addEventListener('open', () => {
        clearTimeout(timeout);
        ws.close();
        reject(new Error('Malformed workflow stream path unexpectedly connected'));
      });
      ws.addEventListener('error', finish, { once: true });
      ws.addEventListener('close', finish, { once: true });
    });

    expect(failed).toBe(true);

    const healthResponse = await fetch(`${server.url}/v1/health`);
    expect(healthResponse.status).toBe(200);
  });

  it('rejects invalid resumeFrom query parameter values', async () => {
    engine = createEngine();
    server = serve({ engine, port: 0 });

    for (const resumeFrom of ['', 'not-a-number', '1.5', '1abc', '0x10', '1e3']) {
      await expectStreamConnectionFailure(server, 'wf-invalid-resume', resumeFrom);
    }

    const healthResponse = await fetch(`${server.url}/v1/health`);
    expect(healthResponse.status).toBe(200);
  });

  it('continues event persistence from the highest stored sequence number', async () => {
    engine = createEngine();
    const storage = engine.storage as MemoryStorage;
    await storage.put(
      KEYS.event('wf-sequence', 4),
      encode({
        type: TokenEvent.type,
        timestamp: Date.now(),
        data: { workflowId: 'wf-sequence', token: 'old', model: 'gpt-4' },
      }),
    );
    server = serve({ engine, port: 0 });

    engine.dispatchEvent(new TokenEvent('wf-sequence', 'new', 'gpt-4'));
    await waitForRealTimersForTesting(200);

    expect(await storage.get(KEYS.event('wf-sequence', 4))).not.toBeNull();
    expect(await storage.get(KEYS.event('wf-sequence', 5))).not.toBeNull();
  });

  it('persists streamed token chunks under the durable blob prefix', async () => {
    engine = createEngine();
    const storage = engine.storage as MemoryStorage;
    server = serve({ engine, port: 0 });

    engine.dispatchEvent(new TokenEvent('wf-token-blob', 'alpha', 'gpt-4'));
    await waitForRealTimersForTesting(200);

    const storedChunk = await storage.get(KEYS.streamChunk('wf-token-blob', 'tokens', 0));
    expect(storedChunk).not.toBeNull();
    expect(decode(storedChunk!)).toEqual({
      workflowId: 'wf-token-blob',
      token: 'alpha',
      model: 'gpt-4',
    });
  });

  it('retries event sequence initialization after a failed scan', async () => {
    engine = createEngine();
    const storage = engine.storage as MemoryStorage;
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
    const originalScan = storage.scan.bind(storage);
    let failFirstEventScan = true;
    const restoreScan = overrideProperty(storage, 'scan', async function* (
      prefix: string,
      options?: Parameters<MemoryStorage['scan']>[1],
    ) {
      if (prefix === 'ev:wf-sequence-retry:' && failFirstEventScan) {
        failFirstEventScan = false;
        throw new Error('event scan failed');
      }
      yield* originalScan(prefix, options);
    } as MemoryStorage['scan']);
    server = serve({ engine, port: 0 });

    try {
      engine.dispatchEvent(new TokenEvent('wf-sequence-retry', 'first', 'gpt-4'));
      await waitForRealTimersForTesting(200);
      engine.dispatchEvent(new TokenEvent('wf-sequence-retry', 'second', 'gpt-4'));
      await waitForRealTimersForTesting(200);

      expect(await storage.get(KEYS.event('wf-sequence-retry', 0))).not.toBeNull();
      expect(errorSpy).toHaveBeenCalled();
    } finally {
      restoreScan();
      errorSpy.mockRestore();
    }
  });

  it('retries token sequence initialization after a failed scan', async () => {
    engine = createEngine();
    const storage = engine.storage as MemoryStorage;
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
    const originalScan = storage.scan.bind(storage);
    let failFirstTokenScan = true;
    const restoreScan = overrideProperty(storage, 'scan', async function* (
      prefix: string,
      options?: Parameters<MemoryStorage['scan']>[1],
    ) {
      if (
        prefix === KEYS.streamChunkPrefix('wf-token-sequence-retry', 'tokens') &&
        failFirstTokenScan
      ) {
        failFirstTokenScan = false;
        throw new Error('token scan failed');
      }
      yield* originalScan(prefix, options);
    } as MemoryStorage['scan']);
    server = serve({ engine, port: 0 });

    try {
      engine.dispatchEvent(new TokenEvent('wf-token-sequence-retry', 'first', 'gpt-4'));
      await waitFor(() => errorSpy.mock.calls.length > 0, {
        label: 'initial token sequence scan failure to surface',
      });
      engine.dispatchEvent(new TokenEvent('wf-token-sequence-retry', 'second', 'gpt-4'));
      await waitFor(
        async () =>
          (await storage.get(KEYS.streamChunk('wf-token-sequence-retry', 'tokens', 0))) !== null,
        {
          label: 'token chunk persistence after retry',
        },
      );

      expect(
        await storage.get(KEYS.streamChunk('wf-token-sequence-retry', 'tokens', 0)),
      ).not.toBeNull();
      expect(errorSpy).toHaveBeenCalled();
    } finally {
      restoreScan();
      errorSpy.mockRestore();
    }
  });

  it('replays only missing token chunks when resumeFrom is provided', async () => {
    engine = createEngine();
    server = serve({ engine, port: 0 });

    engine.dispatchEvent(new TokenEvent('wf-resume', 'first', 'gpt-4'));
    engine.dispatchEvent(new TokenEvent('wf-resume', 'second', 'gpt-4'));
    await waitForRealTimersForTesting(200);

    const ws = await connectStream(server, 'wf-resume', { resumeFrom: 0 });
    const messages = collectMessages(ws);
    await waitForRealTimersForTesting(200);

    const replayMessages = messages.filter((message) => message.type === TokenEvent.type);
    expect(replayMessages).toHaveLength(1);
    expect(replayMessages[0]?.['sequence']).toBe(1);
    expect(replayMessages[0]?.['data']).toMatchObject({ token: 'second' });

    ws.close();
    await waitForRealTimersForTesting(50);
  });

  it('clamps resumeFrom above the durable token range so live tokens still arrive', async () => {
    engine = createEngine();
    server = serve({ engine, port: 0 });

    engine.dispatchEvent(new TokenEvent('wf-resume-clamped', 'first', 'gpt-4'));
    await waitForRealTimersForTesting(200);

    const ws = await connectStream(server, 'wf-resume-clamped', { resumeFrom: 999 });
    const messages = collectMessages(ws);
    await waitForRealTimersForTesting(50);

    engine.dispatchEvent(new TokenEvent('wf-resume-clamped', 'second', 'gpt-4'));
    await waitForRealTimersForTesting(200);

    const tokenMessages = messages.filter((message) => message.type === TokenEvent.type);
    expect(tokenMessages).toHaveLength(1);
    expect(tokenMessages[0]?.['sequence']).toBe(1);
    expect(tokenMessages[0]?.['data']).toMatchObject({ token: 'second', model: 'gpt-4' });

    ws.close();
    await waitForRealTimersForTesting(50);
  });

  it('treats a resume cursor with no durable token chunks as an empty replay cursor', async () => {
    engine = createEngine();
    server = serve({ engine, port: 0 });

    const ws = await connectStream(server, 'wf-resume-empty', { resumeFrom: 999 });
    const messages = collectMessages(ws);
    await waitForRealTimersForTesting(50);

    engine.dispatchEvent(new TokenEvent('wf-resume-empty', 'live', 'gpt-4'));
    await waitForRealTimersForTesting(200);

    const tokenMessages = messages.filter((message) => message.type === TokenEvent.type);
    expect(tokenMessages).toHaveLength(1);
    expect(tokenMessages[0]?.['sequence']).toBe(0);
    expect(tokenMessages[0]?.['data']).toMatchObject({ token: 'live', model: 'gpt-4' });

    ws.close();
    await waitForRealTimersForTesting(50);
  });

  it('treats missing or malformed durable token sequences as an empty replay cursor', async () => {
    engine = createEngine();
    const storage = engine.storage as MemoryStorage;
    await storage.put(
      `${KEYS.streamChunkPrefix('wf-resume-malformed', 'tokens')}zzz`,
      encode({ workflowId: 'wf-resume-malformed', token: 'stale', model: 'gpt-4' }),
    );
    server = serve({ engine, port: 0 });

    const ws = await connectStream(server, 'wf-resume-malformed', { resumeFrom: 999 });
    const messages = collectMessages(ws);
    await waitForRealTimersForTesting(50);

    engine.dispatchEvent(new TokenEvent('wf-resume-malformed', 'live', 'gpt-4'));
    await waitForRealTimersForTesting(200);

    const tokenMessages = messages.filter((message) => message.type === TokenEvent.type);
    expect(tokenMessages).toHaveLength(1);
    expect(tokenMessages[0]?.['sequence']).toBe(0);
    expect(tokenMessages[0]?.['data']).toMatchObject({ token: 'live', model: 'gpt-4' });

    ws.close();
    await waitForRealTimersForTesting(50);
  });

  it('buffers live token events that arrive while replay is still in progress', async () => {
    engine = createEngine();
    server = serve({ engine, port: 0 });

    engine.dispatchEvent(new TokenEvent('wf-overlap', 'first', 'gpt-4'));
    engine.dispatchEvent(new TokenEvent('wf-overlap', 'second', 'gpt-4'));
    await waitForRealTimersForTesting(200);

    const originalGetStreamChunks = engine.getStreamChunks.bind(engine);
    let releaseReplay!: () => void;
    const replayGate = new Promise<void>((resolve) => {
      releaseReplay = resolve;
    });
    let shouldBlockReplay = true;

    engine.getStreamChunks = async (...args) => {
      if (
        shouldBlockReplay &&
        args[0] === 'wf-overlap' &&
        args[1] === 'tokens' &&
        args[2]?.after === 0
      ) {
        shouldBlockReplay = false;
        await replayGate;
      }

      return originalGetStreamChunks(...args);
    };

    const ws = await connectStream(server, 'wf-overlap', { resumeFrom: 0 });
    const messages = collectMessages(ws);
    await waitForRealTimersForTesting(50);

    engine.dispatchEvent(new TokenEvent('wf-overlap', 'third', 'gpt-4'));
    await waitForRealTimersForTesting(50);

    releaseReplay();
    await waitForRealTimersForTesting(250);

    const tokenMessages = messages.filter((message) => message.type === TokenEvent.type);
    expect(tokenMessages.map((message) => message['sequence'])).toEqual([1, 2]);
    expect(
      tokenMessages.map((message) => (message['data'] as Record<string, unknown>)?.['token']),
    ).toEqual(['second', 'third']);

    engine.getStreamChunks = originalGetStreamChunks;
    ws.close();
    await waitForRealTimersForTesting(50);
  });

  it('replays stored token chunks after a server restart', async () => {
    const storage = new MemoryStorage();

    engine = new Engine({ storage });
    engine.register(echoWorkflow);
    server = serve({ engine, port: 0 });

    engine.dispatchEvent(new TokenEvent('wf-restart', 'persisted', 'gpt-4'));
    await waitForRealTimersForTesting(200);

    await server.stop();
    engine[Symbol.dispose]();

    engine = new Engine({ storage });
    engine.register(echoWorkflow);
    server = serve({ engine, port: 0 });

    const ws = await connectStream(server, 'wf-restart', { resumeFrom: -1 });
    const messages = collectMessages(ws);
    await waitForRealTimersForTesting(200);

    const replayMessages = messages.filter((message) => message.type === TokenEvent.type);
    expect(replayMessages).toHaveLength(1);
    expect(replayMessages[0]?.['sequence']).toBe(0);
    expect(replayMessages[0]?.['data']).toMatchObject({ token: 'persisted' });

    ws.close();
    await waitForRealTimersForTesting(50);
  });

  it('logs replay failures when stored token scanning throws', async () => {
    engine = createEngine();
    const storage = engine.storage as MemoryStorage;
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
    const originalScan = storage.scan.bind(storage);
    const restoreScan = overrideProperty(storage, 'scan', async function* (
      prefix: string,
      options?: Parameters<MemoryStorage['scan']>[1],
    ) {
      if (prefix === 'blob:wf-replay-failure:tokens:chunk:') {
        throw new Error('replay scan failed');
      }
      yield* originalScan(prefix, options);
    } as MemoryStorage['scan']);
    server = serve({ engine, port: 0 });

    try {
      const ws = await connectStream(server, 'wf-replay-failure');
      await waitForRealTimersForTesting(100);

      expect(errorSpy).toHaveBeenCalledWith(
        '[weft] Failed to replay token stream for workflow "wf-replay-failure":',
        expect.any(Error),
      );

      ws.close();
      await waitForRealTimersForTesting(50);
    } finally {
      restoreScan();
      errorSpy.mockRestore();
    }
  });

  it('does not process worker protocol messages on stream connections', async () => {
    engine = createEngine();
    server = serve({ engine, port: 0 });

    const ws = await connectStream(server, 'test-wf');

    // Send a worker register message — should be ignored
    ws.send(
      JSON.stringify({
        type: 'register',
        protocolVersion: 2,
        workerId: 'rogue',
        activities: ['charge'],
        concurrency: 5,
      }),
    );
    await waitForRealTimersForTesting(50);

    // Registry should be empty — register messages are only for worker paths
    expect(server.registry.size).toBe(0);

    ws.close();
    await waitForRealTimersForTesting(50);
  });

  it('supports multiple concurrent stream clients for the same workflow', async () => {
    engine = createEngine();
    server = serve({ engine, port: 0 });

    const ws1 = await connectStream(server, 'wf-multi');
    const ws2 = await connectStream(server, 'wf-multi');
    const messages1 = collectMessages(ws1);
    const messages2 = collectMessages(ws2);
    await waitForRealTimersForTesting(50);

    engine.dispatchEvent(new TokenEvent('wf-multi', 'shared-token', 'gpt-4'));
    await waitForRealTimersForTesting(200);

    // Both clients should receive the token event
    const tokens1 = messages1.filter((m) => m.type === TokenEvent.type);
    const tokens2 = messages2.filter((m) => m.type === TokenEvent.type);
    expect(tokens1.length).toBe(1);
    expect(tokens2.length).toBe(1);

    ws1.close();
    ws2.close();
    await waitForRealTimersForTesting(50);
  });
});

// ---------------------------------------------------------------------------
// Long-poll HTTP endpoints
// ---------------------------------------------------------------------------

describe('long-poll endpoints (GET /v1/tasks/:queue, POST /v1/tasks/:queue/result)', () => {
  let engine: Engine;
  let server: WeftServer;

  afterEach(async () => {
    await server?.stop();
    engine?.[Symbol.dispose]();
  });

  it('returns 204 when no task is available within timeout', async () => {
    engine = createEngine();
    server = serve({ engine, port: 0 });

    const response = await fetch(`${server.url}/v1/tasks/default?activity=charge&timeout=50`);

    expect(response.status).toBe(204);
  });

  it('rejects task results with invalid status values', async () => {
    engine = createEngine();
    server = serve({ engine, port: 0 });

    const response = await fetch(`${server.url}/v1/tasks/default/result`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ operationId: 'bad-status-op', status: 'cancelled' }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'status must be "completed" or "failed"',
    });
  });

  it('returns 400 when no activity query parameter is provided', async () => {
    engine = createEngine();
    server = serve({ engine, port: 0 });

    const response = await fetch(`${server.url}/v1/tasks/default?timeout=50`);

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain('activity');
  });

  it('returns a queued task immediately', async () => {
    engine = createEngine();
    server = serve({ engine, port: 0 });

    // Dispatch a task with no WebSocket workers — goes to task queue
    await server.dispatchTask({
      operationId: 'op-poll-1',
      activityName: 'charge',
      input: { amount: 100 },
    });

    const response = await fetch(`${server.url}/v1/tasks/default?activity=charge&timeout=1000`);

    expect(response.status).toBe(200);
    const task = (await response.json()) as { operationId: string; activityName: string };
    expect(task.operationId).toBe('op-poll-1');
    expect(task.activityName).toBe('charge');
  });

  it('persists lifecycle metadata when a long-poll worker completes immediately after claim', async () => {
    engine = createEngine();
    server = serve({ engine, port: 0 });

    await server.dispatchTask({
      operationId: 'long-poll-diagnostics-op',
      activityName: 'charge',
      input: { amount: 100 },
      workflowId: 'workflow-long-poll-diagnostics',
    });

    const pollResponse = await fetch(`${server.url}/v1/tasks/default?activity=charge&timeout=1000`);
    expect(pollResponse.status).toBe(200);
    const task = (await pollResponse.json()) as { operationId: string };
    expect(task.operationId).toBe('long-poll-diagnostics-op');

    const resultResponse = await fetch(`${server.url}/v1/tasks/default/result`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        operationId: 'long-poll-diagnostics-op',
        status: 'completed',
        value: { result: 42 },
      }),
    });
    expect(resultResponse.status).toBe(200);

    await waitFor(
      async () =>
        (await engine.storage.get(KEYS.operationResolved('long-poll-diagnostics-op'))) !== null,
      { label: 'long-poll-diagnostics-op to resolve' },
    );

    const resolved = decode(
      (await engine.storage.get(KEYS.operationResolved('long-poll-diagnostics-op')))!,
    ) as ResolvedRecord;
    expect(resolved.workflowId).toBe('workflow-long-poll-diagnostics');
    expect(resolved.activityName).toBe('charge');
    expect(resolved.queue).toBe('default');
    expect(typeof resolved.firstQueuedAt).toBe('number');
    expect(typeof resolved.lastQueuedAt).toBe('number');
    expect(typeof resolved.lastDispatchedAt).toBe('number');
    expect(typeof resolved.completedAt).toBe('number');
    expect(resolved.retryCount).toBe(0);
    expect(resolved.requeueCount).toBe(0);
    expect(resolved.resolutionReason).toBe('completed');
    expect(typeof resolved.queueLatencyMs).toBe('number');
    expect(typeof resolved.executionLatencyMs).toBe('number');

    const metricsResponse = await fetch(`${server.url}/v1/metrics`);
    expect(metricsResponse.status).toBe(200);
    const metricsText = await metricsResponse.text();
    expect(metricsText).toContain('weft_task_queue_latency_count 1');
    expect(metricsText).toContain('weft_task_execution_latency_count 1');
  });

  it('refreshes lastQueuedAt when redispatching an existing queued record to long-poll', async () => {
    const storage = new MemoryStorage();
    engine = new Engine({ storage });
    engine.register(echoWorkflow);
    server = serve({ engine, port: 0 });

    await storage.put(
      KEYS.operationQueued('long-poll-requeue-timing-op'),
      encode({
        operationId: 'long-poll-requeue-timing-op',
        activityName: 'charge',
        input: null,
        queue: 'default',
        attempt: 2,
        visibilityTimeout: 30_000,
        queuedAt: 1_000,
        firstQueuedAt: 500,
        lastQueuedAt: 1_000,
        lastDispatchedAt: 750,
        startedAt: 800,
        retryCount: 1,
        requeueCount: 1,
        lastRequeueReason: 'visibility-timeout',
      } satisfies QueuedRecord),
    );

    const beforeRedispatch = Date.now();
    await server.dispatchTask({
      operationId: 'long-poll-requeue-timing-op',
      activityName: 'charge',
      input: null,
      attempt: 2,
    });

    const persisted = decode(
      (await storage.get(KEYS.operationQueued('long-poll-requeue-timing-op')))!,
    ) as QueuedRecord;
    expect(persisted.firstQueuedAt).toBe(500);
    expect(persisted.lastQueuedAt).toBe(persisted.queuedAt);
    expect(persisted.lastQueuedAt).toBeGreaterThanOrEqual(beforeRedispatch);
    expect(persisted.lastDispatchedAt).toBe(750);
    expect(persisted.startedAt).toBe(800);

    const pendingTask = server.taskQueue.peekPending('default')[0];
    expect(pendingTask?.lastQueuedAt).toBe(persisted.lastQueuedAt);
  });

  it('blocks until a task arrives within the timeout', async () => {
    engine = createEngine();
    server = serve({ engine, port: 0 });

    // Start a poll that will block
    const pollPromise = fetch(`${server.url}/v1/tasks/default?activity=charge&timeout=5000`);

    // Wait a bit, then enqueue a task
    await waitForRealTimersForTesting(100);
    await server.dispatchTask({
      operationId: 'op-delayed',
      activityName: 'charge',
      input: { amount: 50 },
    });

    const response = await pollPromise;
    expect(response.status).toBe(200);
    const task = (await response.json()) as { operationId: string };
    expect(task.operationId).toBe('op-delayed');
  });

  it('filters tasks by activity name', async () => {
    engine = createEngine();
    server = serve({ engine, port: 0 });

    // Queue a 'ship' task
    await server.dispatchTask({
      operationId: 'op-ship',
      activityName: 'ship',
      input: null,
    });

    // Poll for 'charge' only — should not match
    const response = await fetch(`${server.url}/v1/tasks/default?activity=charge&timeout=50`);

    expect(response.status).toBe(204);

    // The 'ship' task should still be in the queue
    expect(server.taskQueue.pendingCount('default')).toBe(1);
  });

  it('accepts task completion via POST', async () => {
    engine = createEngine();
    server = serve({ engine, port: 0 });

    const response = await fetch(`${server.url}/v1/tasks/default/result`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        operationId: 'op-complete-1',
        status: 'completed',
        value: { result: 42 },
      }),
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  it('logs long-poll task result persistence failures without failing the HTTP response', async () => {
    engine = createEngine();
    const storage = engine.storage as MemoryStorage;
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
    const originalBatch = storage.batch.bind(storage);
    const restoreBatch = overrideProperty(storage, 'batch', (async (
      operations: Parameters<MemoryStorage['batch']>[0],
    ) => {
      if (
        operations.some((operation) => operation.key === KEYS.operationResolved('op-complete-fail'))
      ) {
        throw new Error('long-poll resolution failed');
      }
      await originalBatch(operations);
    }) as MemoryStorage['batch']);
    server = serve({ engine, port: 0 });

    try {
      const response = await fetch(`${server.url}/v1/tasks/default/result`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          operationId: 'op-complete-fail',
          status: 'completed',
          value: { result: 42 },
        }),
      });

      expect(response.status).toBe(200);
      expect(errorSpy).toHaveBeenCalledWith(
        '[weft] Failed to transition task "op-complete-fail" to resolved — inflight record may leak:',
        expect.any(Error),
      );
    } finally {
      restoreBatch();
      errorSpy.mockRestore();
    }
  });

  it('returns 400 for invalid completion body', async () => {
    engine = createEngine();
    server = serve({ engine, port: 0 });

    const response = await fetch(`${server.url}/v1/tasks/default/result`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'completed' }),
    });

    expect(response.status).toBe(400);
  });

  it('returns 400 for non-JSON completion body', async () => {
    engine = createEngine();
    server = serve({ engine, port: 0 });

    const response = await fetch(`${server.url}/v1/tasks/default/result`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: 'not json',
    });

    expect(response.status).toBe(400);
  });

  it('invokes the completion callback when task is completed', async () => {
    engine = createEngine();
    server = serve({ engine, port: 0 });

    const results: Array<{ operationId: string; status: string }> = [];

    // Enqueue with a callback
    server.taskQueue.enqueue(
      'default',
      { operationId: 'op-cb', activityName: 'charge', input: null },
      (result) => results.push(result),
    );

    // Complete via HTTP
    await fetch(`${server.url}/v1/tasks/default/result`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        operationId: 'op-cb',
        status: 'completed',
        value: 'done',
      }),
    });

    expect(results).toHaveLength(1);
    expect(results[0]?.operationId).toBe('op-cb');
    expect(results[0]?.status).toBe('completed');
  });

  it('integrates with LongPollWorker end-to-end', async () => {
    engine = createEngine();
    server = serve({ engine, port: 0 });

    const { LongPollWorker } = await import('../worker/long-poll.ts');

    const worker = new LongPollWorker({
      serverUrl: server.url,
      activities: {
        greet: async (input: unknown) => `Hello, ${String(input)}!`,
      },
      concurrency: 3,
      pollTimeout: 5000,
    });

    worker.start();
    await waitForRealTimersForTesting(100);

    // Dispatch a task — no WebSocket workers, so it goes to the queue
    await server.dispatchTask({
      operationId: 'e2e-lp-1',
      activityName: 'greet',
      input: 'World',
    });

    // Wait for the worker to poll, execute, and complete
    await waitForRealTimersForTesting(500);

    // Worker should be running with no in-flight tasks
    expect(worker.running).toBe(true);
    expect(worker.inFlight).toBe(0);

    await worker.stop();
    expect(worker.running).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Task assignment deduplication
// ---------------------------------------------------------------------------

describe('task assignment deduplication', () => {
  let engine: Engine;
  let server: WeftServer;

  afterEach(async () => {
    await server?.stop();
    engine?.[Symbol.dispose]();
  });

  async function connectWorker(
    wsServer: WeftServer,
    path = '/v1/tasks/default/stream',
  ): Promise<WebSocket> {
    const wsUrl = wsServer.url.replace('http://', 'ws://');
    const ws = new WebSocket(`${wsUrl}${path}`);

    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve());
      ws.addEventListener('error', () => reject(new Error('WebSocket connection failed')));
    });

    return ws;
  }

  async function registerWorker(
    ws: WebSocket,
    options: { workerId: string; activities: string[]; concurrency?: number },
  ): Promise<void> {
    ws.send(
      JSON.stringify({
        type: 'register',
        protocolVersion: 2,
        workerId: options.workerId,
        activities: options.activities,
        concurrency: options.concurrency ?? 10,
      }),
    );
    await waitForRealTimersForTesting(50);
  }

  it('rejects duplicate dispatch of the same operationId to WebSocket workers', async () => {
    engine = createEngine();
    server = serve({ engine, port: 0 });

    const ws = await connectWorker(server);
    const received: Array<{ type: string; operationId?: string }> = [];

    ws.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data)) as { type: string; operationId?: string };
      if (message.type === 'task') received.push(message);
    });

    await registerWorker(ws, { workerId: 'w1', activities: ['charge'], concurrency: 5 });

    const first = await server.dispatchTask({
      operationId: 'dup-op',
      activityName: 'charge',
      input: null,
    });
    const second = await server.dispatchTask({
      operationId: 'dup-op',
      activityName: 'charge',
      input: null,
    });

    expect(first).toBe(true);
    expect(second).toBe(false);

    await waitForRealTimersForTesting(50);

    // Worker should receive exactly one task
    expect(received.length).toBe(1);

    ws.close();
    await waitForRealTimersForTesting(50);
  });

  it('rejects duplicate dispatch when the first went to the long-poll queue', async () => {
    engine = createEngine();
    server = serve({ engine, port: 0 });

    // No WebSocket workers — tasks go to long-poll queue
    const first = await server.dispatchTask({
      operationId: 'dup-lp',
      activityName: 'charge',
      input: null,
    });
    const second = await server.dispatchTask({
      operationId: 'dup-lp',
      activityName: 'charge',
      input: null,
    });

    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(server.taskQueue.pendingCount('default')).toBe(1);
  });

  it('rejects duplicate across WebSocket and long-poll paths', async () => {
    engine = createEngine();
    server = serve({ engine, port: 0 });

    const ws = await connectWorker(server);
    await registerWorker(ws, { workerId: 'w1', activities: ['charge'], concurrency: 1 });

    // First dispatch goes to WebSocket worker
    const first = await server.dispatchTask({
      operationId: 'cross-dup',
      activityName: 'charge',
      input: null,
    });
    expect(first).toBe(true);

    // Worker is now at capacity (1/1), so second dispatch would normally go to long-poll.
    // But the operationId is already assigned, so it should be rejected.
    const second = await server.dispatchTask({
      operationId: 'cross-dup',
      activityName: 'charge',
      input: null,
    });
    expect(second).toBe(false);
    expect(server.taskQueue.pendingCount('default')).toBe(0);

    ws.close();
    await waitForRealTimersForTesting(50);
  });

  it('uses assignTask for WebSocket dispatch so in-flight tasks are tracked', async () => {
    engine = createEngine();
    server = serve({ engine, port: 0 });

    const ws = await connectWorker(server);
    await registerWorker(ws, { workerId: 'w1', activities: ['charge'], concurrency: 5 });

    await server.dispatchTask({
      operationId: 'tracked-op',
      activityName: 'charge',
      input: null,
    });

    // The operationId should be tracked in the registry's in-flight tasks
    expect(server.registry.isAssigned('tracked-op')).toBe(true);

    ws.close();
    await waitForRealTimersForTesting(50);
  });

  it('clears in-flight tracking when worker sends taskResult with operationId', async () => {
    engine = createEngine();
    server = serve({ engine, port: 0 });

    const ws = await connectWorker(server);

    // Auto-respond with operationId in the result
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(String(event.data)) as { type: string; operationId?: string };
      if (msg.type === 'task') {
        ws.send(
          JSON.stringify({
            type: 'taskResult',
            operationId: msg.operationId,
            status: 'completed',
            value: 42,
          }),
        );
      }
    });

    await registerWorker(ws, { workerId: 'w1', activities: ['charge'], concurrency: 5 });

    await server.dispatchTask({
      operationId: 'clear-op',
      activityName: 'charge',
      input: null,
    });

    expect(server.registry.isAssigned('clear-op')).toBe(true);

    await waitForRealTimersForTesting(100);

    // After the result arrives, the task should no longer be tracked
    expect(server.registry.isAssigned('clear-op')).toBe(false);
    expect(server.registry.getWorker('w1')?.inFlight).toBe(0);

    ws.close();
    await waitForRealTimersForTesting(50);
  });

  it('rejects unexpected worker taskResult statuses as protocol errors', async () => {
    engine = createEngine();
    server = serve({ engine, port: 0 });

    const ws = await connectWorker(server);
    const protocolError = waitForWorkerMessage(
      ws,
      (message) => message['type'] === 'protocolError',
      'unexpected status protocolError',
    );
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(String(event.data)) as { type: string; operationId?: string };
      if (msg.type === 'task') {
        ws.send(
          JSON.stringify({
            type: 'taskResult',
            operationId: msg.operationId,
            status: 'mystery-status',
          }),
        );
      }
    });

    await registerWorker(ws, { workerId: 'w-unexpected-status', activities: ['charge'] });
    await server.dispatchTask({
      operationId: 'unexpected-status-op',
      activityName: 'charge',
      input: null,
    });

    expect(await protocolError).toMatchObject({
      type: 'protocolError',
      code: 'invalid_message',
    });
    await waitForSocketClose(ws, 'unexpected status socket close');
    expect(server.registry.getWorker('w-unexpected-status')).toBeUndefined();
  });

  it('treats cancelled worker taskResult statuses as failed resolutions', async () => {
    engine = createEngine();
    server = serve({ engine, port: 0 });

    const ws = await connectWorker(server);
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(String(event.data)) as { type: string; operationId?: string };
      if (msg.type === 'task') {
        ws.send(
          JSON.stringify({
            type: 'taskResult',
            operationId: msg.operationId,
            status: 'cancelled',
            error: 'activity cancelled',
          }),
        );
      }
    });

    await registerWorker(ws, { workerId: 'w-cancelled-status', activities: ['charge'] });
    await server.dispatchTask({
      operationId: 'cancelled-status-op',
      activityName: 'charge',
      input: null,
    });

    await waitForRealTimersForTesting(100);

    expect(await engine.storage.get(KEYS.operationInflight('cancelled-status-op'))).toBeNull();
    expect(await engine.storage.get(KEYS.operationResolved('cancelled-status-op'))).not.toBeNull();

    ws.close();
    await waitForRealTimersForTesting(50);
  });

  it('logs task result persistence failures when inflight resolution cannot be stored', async () => {
    engine = createEngine();
    const storage = engine.storage as MemoryStorage;
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
    const originalBatch = storage.batch.bind(storage);
    server = serve({ engine, port: 0 });

    const ws = await connectWorker(server);
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(String(event.data)) as { type: string; operationId?: string };
      if (msg.type === 'task') {
        ws.send(
          JSON.stringify({
            type: 'taskResult',
            operationId: msg.operationId,
            status: 'completed',
            value: null,
          }),
        );
      }
    });

    const restoreBatch = overrideProperty(storage, 'batch', (async (
      operations: Parameters<MemoryStorage['batch']>[0],
    ) => {
      if (
        operations.some((operation) => operation.key === KEYS.operationResolved('task-result-fail'))
      ) {
        throw new Error('resolved batch failed');
      }
      await originalBatch(operations);
    }) as MemoryStorage['batch']);

    try {
      await registerWorker(ws, { workerId: 'w-task-result-fail', activities: ['charge'] });
      await server.dispatchTask({
        operationId: 'task-result-fail',
        activityName: 'charge',
        input: null,
      });

      await waitForRealTimersForTesting(150);

      expect(errorSpy).toHaveBeenCalledWith(
        '[weft] Failed to transition task "task-result-fail" to resolved — inflight record may leak:',
        expect.any(Error),
      );

      ws.close();
      await waitForRealTimersForTesting(50);
    } finally {
      restoreBatch();
      errorSpy.mockRestore();
    }
  });

  it('rejects taskResult without operationId as a protocol error', async () => {
    engine = createEngine();
    server = serve({ engine, port: 0 });

    const ws = await connectWorker(server);
    const protocolError = waitForWorkerMessage(
      ws,
      (message) => message['type'] === 'protocolError',
      'missing operationId protocolError',
    );
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(String(event.data)) as { type: string };
      if (msg.type === 'task') {
        ws.send(JSON.stringify({ type: 'taskResult', status: 'completed', value: null }));
      }
    });

    await registerWorker(ws, { workerId: 'w-missing-op-id', activities: ['charge'] });
    await server.dispatchTask({
      operationId: 'missing-op-id-op',
      activityName: 'charge',
      input: null,
    });

    expect(await protocolError).toMatchObject({
      type: 'protocolError',
      code: 'invalid_message',
    });
    await waitForSocketClose(ws, 'missing operationId socket close');
    expect(server.registry.getWorker('w-missing-op-id')).toBeUndefined();
  });

  it('ignores stale socket close events after a worker reconnects', async () => {
    engine = createEngine();
    // Disable the reconnect grace period so the stale-socket guard is the
    // only path that could ignore the close event (the assertion this test
    // pins). With a non-zero grace period, the timer might fire after the
    // 100ms test wait and produce a different observable.
    server = serve({ engine, port: 0, workerReconnectGracePeriodMs: 0 });
    const warningSpy = spyOn(console, 'warn').mockImplementation(() => {});

    try {
      const ws1 = await connectWorker(server);
      await registerWorker(ws1, { workerId: 'reconnecting-worker', activities: ['charge'] });

      const ws2 = await connectWorker(server);
      await registerWorker(ws2, { workerId: 'reconnecting-worker', activities: ['charge'] });

      ws1.close();
      await waitForRealTimersForTesting(100);

      expect(server.registry.getWorker('reconnecting-worker')).toBeDefined();
      expect(warningSpy).toHaveBeenCalled();

      ws2.close();
      await waitForRealTimersForTesting(50);
    } finally {
      warningSpy.mockRestore();
    }
  });

  it('allows re-dispatch of an operationId after completion', async () => {
    engine = createEngine();
    server = serve({ engine, port: 0 });

    const ws = await connectWorker(server);
    const received: Array<{ type: string; operationId?: string }> = [];

    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(String(event.data)) as { type: string; operationId?: string };
      received.push(msg);
      if (msg.type === 'task') {
        ws.send(
          JSON.stringify({
            type: 'taskResult',
            operationId: msg.operationId,
            status: 'completed',
            value: null,
          }),
        );
      }
    });

    await registerWorker(ws, { workerId: 'w1', activities: ['charge'], concurrency: 5 });

    // First dispatch
    await server.dispatchTask({ operationId: 'reuse-op', activityName: 'charge', input: null });
    await waitFor(
      () =>
        received.filter((message) => message.type === 'task').length === 1 &&
        !server.registry.isAssigned('reuse-op'),
      { label: 'first reuse-op dispatch to complete' },
    );

    // After completion, dispatch the same operationId again
    const second = await server.dispatchTask({
      operationId: 'reuse-op',
      activityName: 'charge',
      input: null,
    });
    expect(second).toBe(true);

    await waitForRealTimersForTesting(50);

    // Worker should have received two tasks
    const taskMessages = received.filter((m) => m.type === 'task');
    expect(taskMessages.length).toBe(2);

    ws.close();
    await waitForRealTimersForTesting(50);
  });
});

// ---------------------------------------------------------------------------
// Visibility timeout persistence
// ---------------------------------------------------------------------------

describe('visibility timeout persistence', () => {
  let engine: Engine;
  let server: WeftServer;
  let storage: MemoryStorage;

  afterEach(async () => {
    await server?.stop();
    engine?.[Symbol.dispose]();
  });

  function createEngineWithStorage(): { engine: Engine; storage: MemoryStorage } {
    const s = new MemoryStorage();
    const e = new Engine({ storage: s });
    e.register(echoWorkflow);
    return { engine: e, storage: s };
  }

  async function connectWorker(wsServer: WeftServer): Promise<WebSocket> {
    const wsUrl = wsServer.url.replace('http://', 'ws://');
    const ws = new WebSocket(`${wsUrl}/v1/tasks/default/stream`);
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve());
      ws.addEventListener('error', () => reject(new Error('WebSocket connection failed')));
    });
    return ws;
  }

  async function registerWorker(
    ws: WebSocket,
    options: { workerId: string; activities: string[]; concurrency?: number },
  ): Promise<void> {
    ws.send(
      JSON.stringify({
        type: 'register',
        protocolVersion: 2,
        workerId: options.workerId,
        activities: options.activities,
        concurrency: options.concurrency ?? 10,
      }),
    );
    await waitForRealTimersForTesting(50);
  }

  it('persists in-flight record to storage on dispatch', async () => {
    ({ engine, storage } = createEngineWithStorage());
    server = serve({ engine, port: 0 });

    const ws = await connectWorker(server);
    await registerWorker(ws, { workerId: 'w1', activities: ['charge'], concurrency: 5 });

    await server.dispatchTask({
      operationId: 'vt-op-1',
      activityName: 'charge',
      input: { amount: 100 },
    });
    await waitForRealTimersForTesting(50);

    const key = KEYS.operationInflight('vt-op-1');
    const raw = await storage.get(key);
    expect(raw).not.toBeNull();

    const record = decode(raw!) as { operationId: string; workerId: string; deadline: number };
    expect(record.operationId).toBe('vt-op-1');
    expect(record.workerId).toBe('w1');
    expect(record.deadline).toBeGreaterThan(Date.now());

    ws.close();
    await waitForRealTimersForTesting(50);
  });

  it('removes in-flight record from storage on task completion', async () => {
    ({ engine, storage } = createEngineWithStorage());
    server = serve({ engine, port: 0 });

    const ws = await connectWorker(server);

    // Auto-respond to tasks with a completed result
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(String(event.data)) as { type: string; operationId?: string };
      if (msg.type === 'task') {
        ws.send(
          JSON.stringify({
            type: 'taskResult',
            operationId: msg.operationId,
            status: 'completed',
            value: 42,
          }),
        );
      }
    });

    await registerWorker(ws, { workerId: 'w1', activities: ['charge'], concurrency: 5 });

    await server.dispatchTask({ operationId: 'vt-op-2', activityName: 'charge', input: null });

    const key = KEYS.operationInflight('vt-op-2');
    await waitFor(
      async () =>
        (await storage.get(key)) === null &&
        (await storage.get(KEYS.operationResolved('vt-op-2'))) !== null,
      { label: 'vt-op-2 inflight record to resolve' },
    );

    ws.close();
    await waitForRealTimersForTesting(50);
  });

  it('uses custom visibility timeout from TaskDispatch', async () => {
    ({ engine, storage } = createEngineWithStorage());
    server = serve({ engine, port: 0 });

    const ws = await connectWorker(server);
    await registerWorker(ws, { workerId: 'w1', activities: ['charge'], concurrency: 5 });

    const customTimeout = 120_000; // 2 minutes
    await server.dispatchTask({
      operationId: 'vt-op-3',
      activityName: 'charge',
      input: null,
      visibilityTimeout: customTimeout,
    });
    await waitForRealTimersForTesting(50);

    const key = KEYS.operationInflight('vt-op-3');
    const raw = await storage.get(key);
    expect(raw).not.toBeNull();

    const record = decode(raw!) as {
      operationId: string;
      visibilityTimeout: number;
      deadline: number;
    };
    expect(record.visibilityTimeout).toBe(customTimeout);
    // Deadline should be roughly now + 120s (within a generous margin)
    expect(record.deadline).toBeGreaterThan(Date.now() + 100_000);

    ws.close();
    await waitForRealTimersForTesting(50);
  });

  it('defaults visibility timeout to 30 seconds when not specified', async () => {
    ({ engine, storage } = createEngineWithStorage());
    server = serve({ engine, port: 0 });

    const ws = await connectWorker(server);
    await registerWorker(ws, { workerId: 'w1', activities: ['charge'], concurrency: 5 });

    await server.dispatchTask({ operationId: 'vt-op-4', activityName: 'charge', input: null });
    await waitForRealTimersForTesting(50);

    const key = KEYS.operationInflight('vt-op-4');
    const raw = await storage.get(key);
    expect(raw).not.toBeNull();

    const record = decode(raw!) as { visibilityTimeout: number; deadline: number };
    expect(record.visibilityTimeout).toBe(30_000);

    ws.close();
    await waitForRealTimersForTesting(50);
  });

  it('restores in-flight tasks from storage on server restart', async () => {
    ({ engine, storage } = createEngineWithStorage());

    // Pre-populate storage with an in-flight record that hasn't expired
    const deadline = Date.now() + 60_000;
    const inflightRecord = {
      operationId: 'restored-op',
      workerId: 'old-worker',
      deadline,
      activityName: 'charge',
      queue: 'default',
      input: null,
      attempt: 1,
      visibilityTimeout: 60_000,
    };
    await storage.put(KEYS.operationInflight('restored-op'), encode(inflightRecord));

    // Start the server — it should restore the in-flight record
    server = serve({ engine, port: 0 });
    await waitForRealTimersForTesting(100); // Allow async restore to complete

    // The registry should now track the restored task
    expect(server.registry.isAssigned('restored-op')).toBe(true);
  });

  it('rebuilds workflow cancellation tracking for restored in-flight tasks', async () => {
    ({ engine, storage } = createEngineWithStorage());

    const inflightRecord = {
      operationId: 'restored-cancel-op',
      workerId: 'restored-cancel-worker',
      workflowId: 'wf-restored-cancel',
      deadline: Date.now() + 60_000,
      activityName: 'charge',
      queue: 'default',
      input: null,
      attempt: 1,
      visibilityTimeout: 60_000,
    };
    await storage.put(KEYS.operationInflight('restored-cancel-op'), encode(inflightRecord));

    server = serve({ engine, port: 0 });
    await waitForRealTimersForTesting(100);

    const ws = await connectWorker(server);
    const received: Array<{ type: string; operationId?: string }> = [];
    ws.addEventListener('message', (event) => {
      received.push(JSON.parse(String(event.data)));
    });
    await registerWorker(ws, {
      workerId: 'restored-cancel-worker',
      activities: ['charge'],
      concurrency: 1,
    });

    engine.dispatchEvent(new WorkflowCancelledEvent('wf-restored-cancel'));
    await waitForRealTimersForTesting(100);

    expect(
      received.some((message) => {
        return message.type === 'cancel' && message.operationId === 'restored-cancel-op';
      }),
    ).toBe(true);

    ws.close();
    await waitForRealTimersForTesting(50);
  });

  it('logs corrupt persisted inflight records during restore', async () => {
    ({ engine, storage } = createEngineWithStorage());
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
    await storage.put(KEYS.operationInflight('restore-corrupt-op'), encode({ invalid: true }));

    try {
      server = serve({ engine, port: 0 });
      await waitForRealTimersForTesting(100);

      expect(errorSpy).toHaveBeenCalledWith(
        '[weft] Corrupt inflight record at "op:inflight:restore-corrupt-op" during restore — skipping',
      );
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('retries restore scans and logs when recovery still fails', async () => {
    ({ engine, storage } = createEngineWithStorage());
    const warningSpy = spyOn(console, 'warn').mockImplementation(() => {});
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
    const originalScan = storage.scan.bind(storage);
    let inflightScanAttempts = 0;
    const restoreScan = overrideProperty(storage, 'scan', async function* (
      prefix: string,
      options?: Parameters<MemoryStorage['scan']>[1],
    ) {
      if (prefix === 'op:inflight:') {
        inflightScanAttempts++;
        throw new Error(`restore scan failed ${inflightScanAttempts}`);
      }
      yield* originalScan(prefix, options);
    } as MemoryStorage['scan']);

    try {
      server = serve({ engine, port: 0 });
      await waitForRealTimersForTesting(250);

      expect(warningSpy).toHaveBeenCalled();
      expect(errorSpy).toHaveBeenCalledWith(
        '[weft] Failed to restore in-flight tasks from storage:',
        expect.any(Error),
      );
    } finally {
      restoreScan();
      warningSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it('cleans up expired in-flight records from storage on restart', async () => {
    ({ engine, storage } = createEngineWithStorage());

    // Pre-populate storage with an expired in-flight record
    const expiredRecord = {
      operationId: 'expired-op',
      workerId: 'old-worker',
      deadline: Date.now() - 5000, // Already expired 5s ago
      activityName: 'charge',
      queue: 'default',
      input: null,
      attempt: 1,
      visibilityTimeout: 30_000,
    };
    await storage.put(KEYS.operationInflight('expired-op'), encode(expiredRecord));

    server = serve({ engine, port: 0 });
    await waitForRealTimersForTesting(100);

    // The expired record should be removed from storage
    const raw = await storage.get(KEYS.operationInflight('expired-op'));
    expect(raw).toBeNull();

    // And not tracked in the registry
    expect(server.registry.isAssigned('expired-op')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Worker disconnection triggers task reassignment
// ---------------------------------------------------------------------------

describe('worker disconnection triggers task reassignment', () => {
  let engine: Engine;
  let server: WeftServer;
  let storage: MemoryStorage;

  afterEach(async () => {
    await server?.stop();
    engine?.[Symbol.dispose]();
  });

  function createEngineWithStorage(): { engine: Engine; storage: MemoryStorage } {
    const s = new MemoryStorage();
    const e = new Engine({ storage: s });
    e.register(echoWorkflow);
    return { engine: e, storage: s };
  }

  async function connectWorker(
    wsServer: WeftServer,
    path = '/v1/tasks/default/stream',
  ): Promise<WebSocket> {
    const wsUrl = wsServer.url.replace('http://', 'ws://');
    const ws = new WebSocket(`${wsUrl}${path}`);
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve());
      ws.addEventListener('error', () => reject(new Error('WebSocket connection failed')));
    });
    return ws;
  }

  async function registerWorker(
    ws: WebSocket,
    options: { workerId: string; activities: string[]; concurrency?: number },
  ): Promise<void> {
    ws.send(
      JSON.stringify({
        type: 'register',
        protocolVersion: 2,
        workerId: options.workerId,
        activities: options.activities,
        concurrency: options.concurrency ?? 10,
      }),
    );
    await waitForRealTimersForTesting(50);
  }

  it('requeues in-flight tasks to another worker on disconnect', async () => {
    ({ engine, storage } = createEngineWithStorage());
    server = serve({ engine, port: 0 });

    // Connect two workers
    const ws1 = await connectWorker(server);
    const ws2 = await connectWorker(server);

    const received: Array<{ type: string; operationId?: string; attempt?: number }> = [];
    ws2.addEventListener('message', (event) => {
      received.push(JSON.parse(String(event.data)));
    });

    await registerWorker(ws1, { workerId: 'w1', activities: ['charge'], concurrency: 5 });
    await registerWorker(ws2, { workerId: 'w2', activities: ['charge'], concurrency: 5 });

    // Dispatch a task — goes to w1 (least-loaded, both at 0 but w1 registered first)
    await server.dispatchTask({
      operationId: 'requeue-op-1',
      activityName: 'charge',
      input: { amount: 42 },
    });
    await waitForRealTimersForTesting(50);

    expect(server.registry.isAssigned('requeue-op-1')).toBe(true);

    // Disconnect w1 — its in-flight task should be reassigned to w2
    ws1.close();
    await waitForRealTimersForTesting(200);

    const taskMessages = received.filter((m) => m.type === 'task');
    expect(taskMessages.length).toBe(1);
    expect(taskMessages[0]?.operationId).toBe('requeue-op-1');

    ws2.close();
    await waitForRealTimersForTesting(50);
  });

  it('increments attempt count on reassigned tasks', async () => {
    ({ engine, storage } = createEngineWithStorage());
    server = serve({ engine, port: 0 });

    const ws1 = await connectWorker(server);
    const ws2 = await connectWorker(server);

    const received: Array<{ type: string; operationId?: string; attempt?: number }> = [];
    ws2.addEventListener('message', (event) => {
      received.push(JSON.parse(String(event.data)));
    });

    await registerWorker(ws1, { workerId: 'w1', activities: ['charge'], concurrency: 5 });
    await registerWorker(ws2, { workerId: 'w2', activities: ['charge'], concurrency: 5 });

    await server.dispatchTask({
      operationId: 'attempt-op',
      activityName: 'charge',
      input: null,
      attempt: 2, // Already on attempt 2
    });
    await waitForRealTimersForTesting(50);

    // Disconnect w1 — task should be re-dispatched with attempt 3
    ws1.close();
    await waitForRealTimersForTesting(200);

    const taskMessages = received.filter((m) => m.type === 'task');
    expect(taskMessages.length).toBe(1);
    expect(taskMessages[0]?.attempt).toBe(3);

    ws2.close();
    await waitForRealTimersForTesting(50);
  });

  it('cleans up in-flight storage record on disconnect and reassignment', async () => {
    ({ engine, storage } = createEngineWithStorage());
    server = serve({ engine, port: 0 });

    const ws1 = await connectWorker(server);
    const ws2 = await connectWorker(server);

    await registerWorker(ws1, { workerId: 'w1', activities: ['charge'], concurrency: 5 });
    await registerWorker(ws2, { workerId: 'w2', activities: ['charge'], concurrency: 5 });

    await server.dispatchTask({
      operationId: 'cleanup-op',
      activityName: 'charge',
      input: null,
    });
    await waitForRealTimersForTesting(50);

    // Verify the original in-flight record exists
    const keyBefore = KEYS.operationInflight('cleanup-op');
    expect(await storage.get(keyBefore)).not.toBeNull();

    // Disconnect w1
    ws1.close();
    await waitForRealTimersForTesting(200);

    // The old in-flight record should be deleted (a new one is created for w2)
    // The task should now be assigned in the registry (to w2)
    expect(server.registry.isAssigned('cleanup-op')).toBe(true);

    ws2.close();
    await waitForRealTimersForTesting(50);
  });

  it('requeues to long-poll queue when no other WebSocket worker is available', async () => {
    ({ engine, storage } = createEngineWithStorage());
    server = serve({ engine, port: 0 });

    const ws = await connectWorker(server);
    await registerWorker(ws, { workerId: 'w1', activities: ['charge'], concurrency: 5 });

    await server.dispatchTask({
      operationId: 'fallback-op',
      activityName: 'charge',
      input: { amount: 99 },
    });
    await waitForRealTimersForTesting(50);

    expect(server.registry.isAssigned('fallback-op')).toBe(true);

    // Disconnect the only worker — task should go to long-poll queue
    ws.close();
    await waitForRealTimersForTesting(200);

    // The task should be available via long-poll
    expect(server.taskQueue.pendingCount('default')).toBe(1);
  });

  it('records worker-disconnect requeue metadata and exposes it through diagnostics', async () => {
    ({ engine, storage } = createEngineWithStorage());
    server = serve({ engine, port: 0 });

    const ws = await connectWorker(server);
    await registerWorker(ws, { workerId: 'w-disconnect-diagnostics', activities: ['charge'] });

    await server.dispatchTask({
      operationId: 'disconnect-diagnostics-op',
      activityName: 'charge',
      input: null,
      workflowId: 'workflow-disconnect-diagnostics',
    });
    await waitFor(
      async () => (await storage.get(KEYS.operationInflight('disconnect-diagnostics-op'))) !== null,
      { label: 'disconnect-diagnostics-op to be inflight' },
    );

    ws.close();
    await waitFor(
      async () =>
        (await storage.get(KEYS.operationQueued('disconnect-diagnostics-op'))) !== null &&
        server.taskQueue.pendingCount('default') === 1,
      { label: 'disconnect-diagnostics-op to be requeued' },
    );

    const queued = decode(
      (await storage.get(KEYS.operationQueued('disconnect-diagnostics-op')))!,
    ) as QueuedRecord;
    expect(queued.workflowId).toBe('workflow-disconnect-diagnostics');
    expect(queued.attempt).toBe(2);
    expect(queued.retryCount).toBe(1);
    expect(queued.requeueCount).toBe(1);
    expect(queued.lastRequeueReason).toBe('worker-disconnect');
    expect(queued.lastHeartbeatAt).toBeUndefined();

    const operation = createGetTaskDiagnosticsOperation({
      registry: server.registry,
      taskQueue: server.taskQueue,
      now: () => Date.now() + 1_000,
    });
    const result = await executeOperation(
      'weft.tasks.diagnostics',
      {
        operationId: 'disconnect-diagnostics-op',
        retryStormMinimumAttempts: 1,
        staleQueuedAfterMs: 0,
        limit: 10,
      },
      {
        principal: principalFromApiKey({ subject: 'operator', scopes: ['system:read'] }),
        engine,
        transport: 'jsonRpcStdio',
        registry: createOperationRegistry([operation]),
      },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected task diagnostics result');
    const diagnostics = result.value as GetTaskDiagnosticsOutput;
    expect(diagnostics.items).toContainEqual(
      expect.objectContaining({
        kind: 'retry-storm',
        operationId: 'disconnect-diagnostics-op',
        retryCount: 1,
        requeueCount: 1,
        lastRequeueReason: 'worker-disconnect',
      }),
    );
  });

  it('reassigns multiple in-flight tasks when a worker disconnects', async () => {
    ({ engine, storage } = createEngineWithStorage());
    server = serve({ engine, port: 0 });

    const ws1 = await connectWorker(server);
    const ws2 = await connectWorker(server);

    const received: Array<{ type: string; operationId?: string }> = [];
    ws2.addEventListener('message', (event) => {
      received.push(JSON.parse(String(event.data)));
    });

    await registerWorker(ws1, { workerId: 'w1', activities: ['charge', 'ship'], concurrency: 10 });
    await registerWorker(ws2, { workerId: 'w2', activities: ['charge', 'ship'], concurrency: 10 });

    // Dispatch multiple tasks to w1
    await server.dispatchTask({ operationId: 'multi-op-1', activityName: 'charge', input: null });
    await server.dispatchTask({ operationId: 'multi-op-2', activityName: 'ship', input: null });
    await server.dispatchTask({ operationId: 'multi-op-3', activityName: 'charge', input: null });
    await waitForRealTimersForTesting(100);

    // Record which tasks w1 has in-flight (via the registry).
    const w1Tasks = server.registry.getWorkerTasks('w1');
    const w1TaskIds = w1Tasks.map((t) => t.operationId).toSorted();

    // Clear received so only reassignment messages are captured.
    received.length = 0;

    // Disconnect w1 — tasks assigned to w1 should be reassigned to w2.
    ws1.close();
    await waitForRealTimersForTesting(300);

    const taskMessages = received.filter((m) => m.type === 'task');
    const reassignedIds = taskMessages
      .map((m) => m.operationId)
      .toSorted((a = '', b = '') => (a < b ? -1 : a > b ? 1 : 0));
    // Only w1's tasks should be reassigned, not tasks already on w2.
    expect(reassignedIds).toEqual(w1TaskIds);

    ws2.close();
    await waitForRealTimersForTesting(50);
  });

  it('logs corrupt inflight records when a disconnected worker task cannot be decoded', async () => {
    ({ engine, storage } = createEngineWithStorage());
    server = serve({ engine, port: 0 });
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});

    try {
      const ws = await connectWorker(server);
      await registerWorker(ws, { workerId: 'w-corrupt-disconnect', activities: ['charge'] });

      await server.dispatchTask({
        operationId: 'disconnect-corrupt-op',
        activityName: 'charge',
        input: null,
      });
      await waitForRealTimersForTesting(50);
      await storage.put(KEYS.operationInflight('disconnect-corrupt-op'), encode({ bad: true }));

      ws.close();
      await waitForRealTimersForTesting(150);

      expect(errorSpy).toHaveBeenCalledWith(
        '[weft] Corrupt inflight record for task "disconnect-corrupt-op" — skipping reassignment',
      );
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('warns and clears missing inflight records when a worker disconnects before storage commit', async () => {
    ({ engine, storage } = createEngineWithStorage());
    server = serve({ engine, port: 0 });
    const warningSpy = spyOn(console, 'warn').mockImplementation(() => {});

    try {
      const ws = await connectWorker(server);
      await registerWorker(ws, { workerId: 'w-missing-disconnect', activities: ['charge'] });

      await server.dispatchTask({
        operationId: 'disconnect-missing-op',
        activityName: 'charge',
        input: null,
      });
      await waitForRealTimersForTesting(50);
      await storage.delete(KEYS.operationInflight('disconnect-missing-op'));

      ws.close();
      await waitForRealTimersForTesting(150);

      expect(warningSpy).toHaveBeenCalledWith(
        '[weft] No inflight record found in storage for task "disconnect-missing-op" — skipping reassignment',
      );
      expect(await storage.get(KEYS.operationInflight('disconnect-missing-op'))).toBeNull();
    } finally {
      warningSpy.mockRestore();
    }
  });

  it('logs disconnect reassignment failures when storage access throws', async () => {
    ({ engine, storage } = createEngineWithStorage());
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
    const originalGet = storage.get.bind(storage);
    server = serve({ engine, port: 0 });

    const restoreGet = overrideProperty(storage, 'get', (async (key: string) => {
      if (key === KEYS.operationInflight('disconnect-get-fail-op')) {
        throw new Error('disconnect get failed');
      }
      return originalGet(key);
    }) as MemoryStorage['get']);

    try {
      const ws = await connectWorker(server);
      await registerWorker(ws, { workerId: 'w-disconnect-get-fail', activities: ['charge'] });

      await server.dispatchTask({
        operationId: 'disconnect-get-fail-op',
        activityName: 'charge',
        input: null,
      });
      await waitForRealTimersForTesting(50);

      ws.close();
      await waitForRealTimersForTesting(150);

      expect(errorSpy).toHaveBeenCalledWith(
        '[weft] Failed to reassign task "disconnect-get-fail-op" from worker "w-disconnect-get-fail":',
        expect.any(Error),
      );
    } finally {
      restoreGet();
      errorSpy.mockRestore();
    }
  });

  it('logs immediate redispatch failures when a non-retry-policy task cannot be requeued', async () => {
    ({ engine, storage } = createEngineWithStorage());
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
    const originalPut = storage.put.bind(storage);
    server = serve({ engine, port: 0 });

    const restorePut = overrideProperty(storage, 'put', (async (key: string, value: Uint8Array) => {
      if (key === KEYS.operationQueued('disconnect-redispatch-fail-op')) {
        throw new Error('immediate redispatch failed');
      }
      await originalPut(key, value);
    }) as MemoryStorage['put']);

    try {
      const ws = await connectWorker(server);
      await registerWorker(ws, {
        workerId: 'w-disconnect-redispatch-fail',
        activities: ['charge'],
      });

      await server.dispatchTask({
        operationId: 'disconnect-redispatch-fail-op',
        activityName: 'charge',
        input: null,
      });
      await waitForRealTimersForTesting(50);

      ws.close();
      await waitForRealTimersForTesting(150);

      expect(errorSpy).toHaveBeenCalledWith(
        '[weft] Redispatch failed for "disconnect-redispatch-fail-op":',
        expect.any(Error),
      );
    } finally {
      restorePut();
      errorSpy.mockRestore();
    }
  });

  it('does nothing when a worker with no in-flight tasks disconnects', async () => {
    ({ engine, storage } = createEngineWithStorage());
    // Disable the reconnect grace period so the close handler unregisters
    // the worker synchronously, as this test asserts.
    server = serve({ engine, port: 0, workerReconnectGracePeriodMs: 0 });

    const ws = await connectWorker(server);
    await registerWorker(ws, { workerId: 'w1', activities: ['charge'], concurrency: 5 });

    expect(server.registry.size).toBe(1);

    // Disconnect without any dispatched tasks
    ws.close();
    await waitForRealTimersForTesting(100);

    // Worker should be unregistered, no tasks in queue
    expect(server.registry.size).toBe(0);
    expect(server.taskQueue.pendingCount('default')).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Visibility timeout expiry triggers task reassignment
// ---------------------------------------------------------------------------

describe('visibility timeout expiry triggers task reassignment', () => {
  let engine: Engine;
  let server: WeftServer;
  let storage: MemoryStorage;

  afterEach(async () => {
    await server?.stop();
    engine?.[Symbol.dispose]();
  });

  function createEngineWithStorage(): { engine: Engine; storage: MemoryStorage } {
    const s = new MemoryStorage();
    const e = new Engine({ storage: s });
    e.register(echoWorkflow);
    return { engine: e, storage: s };
  }

  async function connectWorker(
    wsServer: WeftServer,
    path = '/v1/tasks/default/stream',
  ): Promise<WebSocket> {
    const wsUrl = wsServer.url.replace('http://', 'ws://');
    const ws = new WebSocket(`${wsUrl}${path}`);
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve());
      ws.addEventListener('error', () => reject(new Error('WebSocket connection failed')));
    });
    return ws;
  }

  async function registerWorker(
    ws: WebSocket,
    options: { workerId: string; activities: string[]; concurrency?: number },
  ): Promise<void> {
    ws.send(
      JSON.stringify({
        type: 'register',
        protocolVersion: 2,
        workerId: options.workerId,
        activities: options.activities,
        concurrency: options.concurrency ?? 10,
      }),
    );
    await waitForRealTimersForTesting(50);
  }

  it('reassigns tasks whose visibility timeout has expired via storage scan', async () => {
    ({ engine, storage } = createEngineWithStorage());
    server = serve({ engine, port: 0, visibilityPollIntervalMs: 50 });

    const ws = await connectWorker(server);

    // Collect all received messages (including re-dispatches)
    const received: Array<{ type: string; operationId?: string; attempt?: number }> = [];
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(String(event.data)) as {
        type: string;
        operationId?: string;
        attempt?: number;
      };
      received.push(msg);
      // Complete the task on second attempt to stop the reassignment cycle
      if (msg.type === 'task' && (msg.attempt ?? 1) >= 2) {
        ws.send(
          JSON.stringify({
            type: 'taskResult',
            operationId: msg.operationId,
            status: 'completed',
            value: null,
          }),
        );
      }
    });

    await registerWorker(ws, { workerId: 'w1', activities: ['charge'], concurrency: 5 });

    // Dispatch with a very short visibility timeout
    await server.dispatchTask({
      operationId: 'expiry-op-1',
      activityName: 'charge',
      input: { amount: 42 },
      visibilityTimeout: 100, // 100ms — will expire quickly
    });
    await waitForRealTimersForTesting(50);

    // Task should be assigned
    expect(server.registry.isAssigned('expiry-op-1')).toBe(true);

    // Wait for the visibility timeout to expire and the scanner to pick it up
    await waitForRealTimersForTesting(300);

    // The worker should have received the task at least twice (original + reassignment)
    const taskMessages = received.filter(
      (m) => m.type === 'task' && m.operationId === 'expiry-op-1',
    );
    expect(taskMessages.length).toBeGreaterThanOrEqual(2);
    // First dispatch: attempt 1; reassignment: attempt 2
    expect(taskMessages[0]?.attempt).toBe(1);
    expect(taskMessages[1]?.attempt).toBe(2);

    ws.close();
    await waitForRealTimersForTesting(50);
  });

  it('increments attempt count on tasks reassigned due to timeout expiry', async () => {
    ({ engine, storage } = createEngineWithStorage());
    server = serve({ engine, port: 0, visibilityPollIntervalMs: 50 });

    const ws = await connectWorker(server);

    const received: Array<{ type: string; operationId?: string; attempt?: number }> = [];
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(String(event.data)) as {
        type: string;
        operationId?: string;
        attempt?: number;
      };
      received.push(msg);
      // Complete the task on attempt 3 to stop the cycle
      if (msg.type === 'task' && (msg.attempt ?? 1) >= 3) {
        ws.send(
          JSON.stringify({
            type: 'taskResult',
            operationId: msg.operationId,
            status: 'completed',
            value: null,
          }),
        );
      }
    });

    await registerWorker(ws, { workerId: 'w1', activities: ['charge'], concurrency: 5 });

    await server.dispatchTask({
      operationId: 'attempt-expiry-op',
      activityName: 'charge',
      input: null,
      attempt: 2,
      visibilityTimeout: 100,
    });
    await waitForRealTimersForTesting(300);

    const taskMessages = received.filter(
      (m) => m.type === 'task' && m.operationId === 'attempt-expiry-op',
    );
    expect(taskMessages.length).toBeGreaterThanOrEqual(2);
    // First dispatch: attempt 2; reassignment: attempt 3
    expect(taskMessages[0]?.attempt).toBe(2);
    expect(taskMessages[1]?.attempt).toBe(3);

    ws.close();
    await waitForRealTimersForTesting(50);
  });

  it('does not reassign tasks that have not expired', async () => {
    ({ engine, storage } = createEngineWithStorage());
    server = serve({ engine, port: 0, visibilityPollIntervalMs: 50 });

    const ws = await connectWorker(server);

    const received: Array<{ type: string; operationId?: string }> = [];
    ws.addEventListener('message', (event) => {
      received.push(JSON.parse(String(event.data)));
    });

    await registerWorker(ws, { workerId: 'w1', activities: ['charge'], concurrency: 5 });

    // Dispatch with a long visibility timeout
    await server.dispatchTask({
      operationId: 'noexpiry-op',
      activityName: 'charge',
      input: null,
      visibilityTimeout: 60_000,
    });
    await waitForRealTimersForTesting(200);

    // The task should still be assigned, not reassigned
    expect(server.registry.isAssigned('noexpiry-op')).toBe(true);
    // Worker should have received exactly one task message (the initial dispatch, no reassignment)
    const taskMessages = received.filter(
      (m) => m.type === 'task' && m.operationId === 'noexpiry-op',
    );
    expect(taskMessages.length).toBe(1);

    ws.close();
    await waitForRealTimersForTesting(50);
  });

  it('cleans up old storage record and creates new one on reassignment', async () => {
    ({ engine, storage } = createEngineWithStorage());
    server = serve({ engine, port: 0, visibilityPollIntervalMs: 50 });

    const ws = await connectWorker(server);
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(String(event.data)) as {
        type: string;
        operationId?: string;
        attempt?: number;
      };
      // Complete on attempt 2 to stop the reassignment cycle
      if (msg.type === 'task' && (msg.attempt ?? 1) >= 2) {
        ws.send(
          JSON.stringify({
            type: 'taskResult',
            operationId: msg.operationId,
            status: 'completed',
            value: null,
          }),
        );
      }
    });

    await registerWorker(ws, { workerId: 'w1', activities: ['charge'], concurrency: 5 });

    await server.dispatchTask({
      operationId: 'cleanup-expiry-op',
      activityName: 'charge',
      input: null,
      visibilityTimeout: 100,
    });

    // Verify original record exists
    const inflightKey = KEYS.operationInflight('cleanup-expiry-op');
    const rawBefore = await storage.get(inflightKey);
    expect(rawBefore).not.toBeNull();
    const recordBefore = decode(rawBefore!) as { attempt: number };
    expect(recordBefore.attempt).toBe(1);

    // Wait for expiry and reassignment
    await waitFor(async () => (await storage.get(inflightKey)) === null, {
      timeoutMs: 2000,
      label: 'expired task completion cleanup',
    });

    // After the scanner re-dispatches with attempt=2, the worker completes it
    // and the in-flight record is removed from storage.
    const rawAfter = await storage.get(inflightKey);
    expect(rawAfter).toBeNull();

    ws.close();
    await waitForRealTimersForTesting(50);
  });

  it('falls back to long-poll queue when no WebSocket worker available for expired task', async () => {
    ({ engine, storage } = createEngineWithStorage());
    server = serve({ engine, port: 0, visibilityPollIntervalMs: 50 });

    const ws = await connectWorker(server);
    await registerWorker(ws, { workerId: 'w1', activities: ['charge'], concurrency: 5 });

    await server.dispatchTask({
      operationId: 'fallback-expiry-op',
      activityName: 'charge',
      input: null,
      visibilityTimeout: 100,
    });
    await waitForRealTimersForTesting(50);

    // Unregister the worker before the timeout expires, but don't close the WS
    // (simulating a worker that stops heartbeating). Instead, just disconnect:
    ws.close();
    await waitForRealTimersForTesting(300);

    // The expired task should have been cleaned up from storage or requeued to long-poll
    // (worker disconnect already handles this, but storage scan covers edge cases)
    // Verify there are no orphaned in-flight records in storage
    let inflightCount = 0;
    for await (const [_key] of storage.scan('op:inflight:')) {
      inflightCount++;
    }
    // Either the disconnect handler or the scanner cleaned it up
    expect(inflightCount).toBe(0);
  });

  it('scanner cleans up orphaned storage records with no matching registry entry', async () => {
    ({ engine, storage } = createEngineWithStorage());
    server = serve({ engine, port: 0, visibilityPollIntervalMs: 50 });

    // Connect a worker that can receive the reassigned task
    const ws = await connectWorker(server);
    const received: Array<{ type: string; operationId?: string; attempt?: number }> = [];
    ws.addEventListener('message', (event) => {
      received.push(JSON.parse(String(event.data)));
    });
    await registerWorker(ws, { workerId: 'w1', activities: ['charge'], concurrency: 5 });

    // Wait for startup restore to complete, then insert an orphaned expired record.
    // This simulates a record that slipped through (e.g., created by another process).
    await waitForRealTimersForTesting(100);
    const expiredRecord = {
      operationId: 'orphan-op',
      workerId: 'ghost-worker',
      deadline: Date.now() - 5000,
      activityName: 'charge',
      queue: 'default',
      input: null,
      attempt: 1,
      visibilityTimeout: 30_000,
    };
    await storage.put(KEYS.operationInflight('orphan-op'), encode(expiredRecord));

    // Wait for the reconciliation scanner to pick up the orphaned record.
    // Orphaned records (not tracked in the deadline heap) are only discovered
    // by the periodic full-storage reconciliation, which runs at 12x the
    // visibility poll interval (50ms * 12 = 600ms here).
    await waitForRealTimersForTesting(800);

    const taskMessages = received.filter((m) => m.type === 'task' && m.operationId === 'orphan-op');
    expect(taskMessages.length).toBe(1);
    expect(taskMessages[0]?.attempt).toBe(2);

    // Verify the original expired inflight record was replaced — the task was
    // re-dispatched so a new inflight record exists, but its deadline should
    // be in the future (not the stale expired value).
    for await (const [, value] of storage.scan('op:inflight:')) {
      const record = decode(value) as { deadline: number };
      expect(record.deadline).toBeGreaterThan(Date.now() - 1000);
    }

    ws.close();
    await waitForRealTimersForTesting(50);
  });

  it('does not reassign a task when a heartbeat extended its deadline past a stale heap entry', async () => {
    ({ engine, storage } = createEngineWithStorage());
    server = serve({ engine, port: 0, visibilityPollIntervalMs: 50 });

    const ws = await connectWorker(server);
    const received: Array<{ type: string; operationId?: string }> = [];
    ws.addEventListener('message', (event) => {
      received.push(JSON.parse(String(event.data)));
    });
    await registerWorker(ws, { workerId: 'w-heartbeat-stale-heap', activities: ['charge'] });

    await server.dispatchTask({
      operationId: 'heartbeat-stale-heap-op',
      activityName: 'charge',
      input: null,
      visibilityTimeout: 2000,
    });

    const initialRecord = decode(
      (await storage.get(KEYS.operationInflight('heartbeat-stale-heap-op')))!,
    ) as { deadline: number };

    await waitForRealTimersForTesting(1000);
    ws.send(JSON.stringify({ type: 'heartbeat', workerId: 'w-heartbeat-stale-heap' }));

    let extendedDeadline = initialRecord.deadline;
    for (let attempt = 0; attempt < 20; attempt++) {
      const persisted = decode(
        (await storage.get(KEYS.operationInflight('heartbeat-stale-heap-op')))!,
      ) as { deadline: number };
      extendedDeadline = persisted.deadline;
      if (extendedDeadline > initialRecord.deadline) break;
      await waitForRealTimersForTesting(10);
    }

    expect(extendedDeadline).toBeGreaterThan(initialRecord.deadline);

    const beforeScanTaskCount = received.filter((message) => message.type === 'task').length;
    const staleDeadlineDelay = Math.max(0, initialRecord.deadline - Date.now()) + 100;
    expect(Date.now() + staleDeadlineDelay).toBeLessThan(extendedDeadline);
    await waitForRealTimersForTesting(staleDeadlineDelay);
    expect(Date.now()).toBeGreaterThanOrEqual(initialRecord.deadline);
    const afterScanTaskCount = received.filter((message) => message.type === 'task').length;

    expect(afterScanTaskCount).toBe(beforeScanTaskCount);
    expect(server.registry.isAssigned('heartbeat-stale-heap-op')).toBe(true);

    const persisted = decode(
      (await storage.get(KEYS.operationInflight('heartbeat-stale-heap-op')))!,
    ) as { deadline: number };
    // The deadline may advance further if another heartbeat fires during the
    // sleep above — the only invariant is that it never regresses to the
    // stale initialRecord.deadline value that the expiry scan would pick up.
    expect(persisted.deadline).toBeGreaterThanOrEqual(extendedDeadline);

    ws.close();
    await waitForRealTimersForTesting(50);
  });

  it('keeps an in-flight task when the expiry scan encounters a stale heap entry', async () => {
    ({ engine, storage } = createEngineWithStorage());

    const operationId = 'stale-expiry-scan-op';
    const futureDeadline = Date.now() + 5_000;
    const inflightRecord = {
      operationId,
      workerId: 'restored-worker',
      deadline: futureDeadline,
      activityName: 'charge',
      queue: 'default',
      input: null,
      attempt: 1,
      visibilityTimeout: 30_000,
    };
    await storage.put(KEYS.operationInflight(operationId), encode(inflightRecord));

    const originalAdd = DeadlineTracker.prototype.add;
    const originalDrainExpired = DeadlineTracker.prototype.drainExpired;
    let addCountForOperation = 0;
    let injectedStaleEntry = false;

    const restoreAdd = overrideProperty(
      DeadlineTracker.prototype,
      'add',
      function (
        this: DeadlineTracker,
        entry: Parameters<DeadlineTracker['add']>[0],
      ): ReturnType<DeadlineTracker['add']> {
        if (entry.operationId === operationId) {
          addCountForOperation++;
        }
        return originalAdd.call(this, entry);
      },
    );

    const restoreDrainExpired = overrideProperty(
      DeadlineTracker.prototype,
      'drainExpired',
      function (
        this: DeadlineTracker,
        now: Parameters<DeadlineTracker['drainExpired']>[0],
      ): ReturnType<DeadlineTracker['drainExpired']> {
        const expired = originalDrainExpired.call(this, now);
        if (!injectedStaleEntry) {
          injectedStaleEntry = true;
          return [...expired, { operationId, deadline: now - 1 }];
        }
        return expired;
      },
    );

    try {
      server = serve({ engine, port: 0, visibilityPollIntervalMs: 25 });
      await waitForRealTimersForTesting(200);

      expect(injectedStaleEntry).toBe(true);
      expect(addCountForOperation).toBeGreaterThanOrEqual(2);
      expect(server.registry.isAssigned(operationId)).toBe(true);

      const persisted = decode((await storage.get(KEYS.operationInflight(operationId)))!) as {
        deadline: number;
      };
      expect(persisted.deadline).toBe(futureDeadline);
    } finally {
      restoreDrainExpired();
      restoreAdd();
    }
  });

  it('logs corrupt inflight records when the visibility scanner encounters invalid storage', async () => {
    ({ engine, storage } = createEngineWithStorage());
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
    server = serve({ engine, port: 0, visibilityPollIntervalMs: 50 });

    try {
      const ws = await connectWorker(server);
      await registerWorker(ws, { workerId: 'w-visibility-corrupt', activities: ['charge'] });

      await server.dispatchTask({
        operationId: 'visibility-corrupt-op',
        activityName: 'charge',
        input: null,
        visibilityTimeout: 100,
      });
      await waitForRealTimersForTesting(50);
      await storage.put(KEYS.operationInflight('visibility-corrupt-op'), encode({ invalid: true }));

      await waitForRealTimersForTesting(200);

      expect(errorSpy).toHaveBeenCalledWith(
        '[weft] Corrupt inflight record for task "visibility-corrupt-op" — skipping',
      );

      ws.close();
      await waitForRealTimersForTesting(50);
    } finally {
      errorSpy.mockRestore();
    }
  });

  // -------------------------------------------------------------------------
  // Regression: the deadline-heap fast path and the full-storage reconciliation
  // scanner must not both process the same expired task. Before the fix they
  // each had their own running guard but no shared per-operation coordination,
  // so both could call `registry.completeTask` / `reassignOrExpireTask` for
  // the same operationId and dispatch duplicate `ActivityFailedEvent`s when
  // retries were exhausted.
  //
  // In-memory storage resolves faster than the event loop, so the race window
  // is vanishingly small under normal load. We wrap `MemoryStorage` with a
  // subclass that stalls reads of the target inflight key long enough for the
  // other scanner to also observe the still-present record before either call
  // completes — making the race reliably reproducible in tests.
  // -------------------------------------------------------------------------
  it('dispatches ActivityFailedEvent exactly once when both scanners race on the same expired task', async () => {
    const targetOperationId = 'race-op-1';

    class DelayedStorage extends MemoryStorage {
      #stalledOnce = false;

      override async get(key: string): Promise<Uint8Array | null> {
        const value = await super.get(key);
        if (
          !this.#stalledOnce &&
          key === KEYS.operationInflight(targetOperationId) &&
          value !== null
        ) {
          this.#stalledOnce = true;
          // Park long enough for the reconciliation scanner to also tick
          // (its interval is visibility × 12 = 120ms) and observe the
          // still-present inflight record before this caller proceeds to
          // `transitionInflightToResolved`. 200ms is well past both one
          // reconciliation period and the fast-path retry cadence.
          await new Promise<void>((resolve) => setTimeout(resolve, 200));
        }
        return value;
      }
    }

    const delayedStorage = new DelayedStorage();
    const localEngine = new Engine({ storage: delayedStorage });
    localEngine.register(echoWorkflow);
    const localServer = serve({
      engine: localEngine,
      port: 0,
      visibilityPollIntervalMs: 10,
    });

    try {
      const failedOperationIds: string[] = [];
      localEngine.addEventListener(ActivityFailedEvent.type, (event) => {
        if (event instanceof ActivityFailedEvent) {
          failedOperationIds.push(event.operationId);
        }
      });

      const workflowId = 'race-wf-1';
      const policy: RetryPolicy = {
        maxAttempts: 1,
        initialBackoff: 10,
        backoffMultiplier: 1,
        maxBackoff: 10,
      };

      // Connect a worker so `dispatchTask` adds the record to the deadline
      // heap (rather than falling through to the long-poll queue).
      const wsUrl = localServer.url.replace('http://', 'ws://');
      const ws = new WebSocket(`${wsUrl}/v1/tasks/default/stream`);
      await new Promise<void>((resolve, reject) => {
        ws.addEventListener('open', () => resolve());
        ws.addEventListener('error', () => reject(new Error('ws failed')));
      });
      ws.send(
        JSON.stringify({
          type: 'register',
          protocolVersion: 2,
          workerId: 'race-worker',
          activities: ['charge'],
          concurrency: 1,
        }),
      );
      await waitForRealTimersForTesting(50);

      await localServer.dispatchTask({
        operationId: targetOperationId,
        activityName: 'charge',
        input: null,
        workflowId,
        visibilityTimeout: 50,
        retryPolicy: policy,
      });

      // Give both scanners many ticks to race on the same expired record.
      // The fast path fires every 10ms; the reconciliation scan fires every
      // 120ms (10ms × RECONCILIATION_MULTIPLIER). The delayed read parks for
      // 200ms, spanning at least one reconciliation tick, so the bug would
      // produce a duplicate failure event.
      await waitForRealTimersForTesting(700);

      const relevant = failedOperationIds.filter((id) => id === targetOperationId);
      expect(relevant.length).toBe(1);

      ws.close();
      await waitForRealTimersForTesting(50);
    } finally {
      await localServer.stop();
      localEngine[Symbol.dispose]();
    }
  });

  it('logs and retries expired-task processing failures in the visibility scanner', async () => {
    ({ engine, storage } = createEngineWithStorage());
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
    const originalGet = storage.get.bind(storage);
    server = serve({ engine, port: 0, visibilityPollIntervalMs: 50 });

    const restoreGet = overrideProperty(storage, 'get', (async (key: string) => {
      if (key === KEYS.operationInflight('visibility-retry-op')) {
        throw new Error('visibility get failed');
      }
      return originalGet(key);
    }) as MemoryStorage['get']);

    try {
      const ws = await connectWorker(server);
      await registerWorker(ws, { workerId: 'w-visibility-retry', activities: ['charge'] });

      await server.dispatchTask({
        operationId: 'visibility-retry-op',
        activityName: 'charge',
        input: null,
        visibilityTimeout: 100,
      });
      await waitForRealTimersForTesting(200);

      expect(errorSpy).toHaveBeenCalledWith(
        '[weft] Failed to process expired task "visibility-retry-op" — will retry:',
        expect.any(Error),
      );

      ws.close();
      await waitForRealTimersForTesting(50);
    } finally {
      restoreGet();
      errorSpy.mockRestore();
    }
  });

  it('logs top-level visibility scanner failures', async () => {
    ({ engine, storage } = createEngineWithStorage());
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
    const originalDrainExpired = DeadlineTracker.prototype.drainExpired;
    server = serve({ engine, port: 0, visibilityPollIntervalMs: 20 });

    try {
      DeadlineTracker.prototype.drainExpired = function drainExpiredFailure() {
        throw new Error('drain expired failed');
      };

      await waitForRealTimersForTesting(80);

      expect(errorSpy).toHaveBeenCalledWith(
        '[weft] Visibility timeout scanner error:',
        expect.any(Error),
      );
    } finally {
      DeadlineTracker.prototype.drainExpired = originalDrainExpired;
      errorSpy.mockRestore();
    }
  });

  it('reconciliation tracks non-expired orphaned records so the fast scanner can expire them later', async () => {
    ({ engine, storage } = createEngineWithStorage());
    server = serve({ engine, port: 0, visibilityPollIntervalMs: 20 });

    const ws = await connectWorker(server);
    const received: Array<{ type: string; operationId?: string; attempt?: number }> = [];
    ws.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data)) as {
        type: string;
        operationId?: string;
        attempt?: number;
      };
      received.push(message);
      if (message.type === 'task' && message.operationId === 'orphan-track-op') {
        ws.send(
          JSON.stringify({
            type: 'taskResult',
            operationId: message.operationId,
            status: 'completed',
            value: null,
          }),
        );
      }
    });
    await registerWorker(ws, { workerId: 'w-reconcile-track', activities: ['charge'] });

    await waitForRealTimersForTesting(50);
    await storage.put(
      KEYS.operationInflight('orphan-track-op'),
      encode({
        operationId: 'orphan-track-op',
        workerId: 'ghost-worker',
        deadline: Date.now() + 500,
        activityName: 'charge',
        queue: 'default',
        input: null,
        attempt: 1,
        visibilityTimeout: 500,
      }),
    );

    await waitForRealTimersForTesting(300);

    const earlyTaskMessages = received.filter((message) => {
      return message.type === 'task' && message.operationId === 'orphan-track-op';
    });
    expect(earlyTaskMessages).toHaveLength(0);

    await waitForRealTimersForTesting(500);

    const taskMessages = received.filter((message) => {
      return message.type === 'task' && message.operationId === 'orphan-track-op';
    });
    expect(taskMessages.length).toBeGreaterThanOrEqual(1);
    expect(taskMessages[0]?.attempt).toBe(2);

    ws.close();
    await waitForRealTimersForTesting(50);
  });

  it('logs per-record reconciliation failures and skips the bad entry', async () => {
    ({ engine, storage } = createEngineWithStorage());
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
    server = serve({ engine, port: 0, visibilityPollIntervalMs: 20 });

    try {
      await waitForRealTimersForTesting(50);
      await storage.put(KEYS.operationInflight('reconcile-bad-op'), new Uint8Array([1, 2, 3]));

      await waitForRealTimersForTesting(300);

      expect(errorSpy).toHaveBeenCalledWith(
        '[weft] Failed to reconcile inflight record — skipping:',
        expect.any(Error),
      );
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('logs reconciliation scan failures', async () => {
    ({ engine, storage } = createEngineWithStorage());
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
    const originalScan = storage.scan.bind(storage);
    let inflightScanCalls = 0;
    const restoreScan = overrideProperty(storage, 'scan', async function* (
      prefix: string,
      options?: Parameters<MemoryStorage['scan']>[1],
    ) {
      if (prefix === 'op:inflight:') {
        inflightScanCalls++;
        if (inflightScanCalls >= 2) {
          throw new Error('reconciliation scan failed');
        }
      }
      yield* originalScan(prefix, options);
    } as MemoryStorage['scan']);
    server = serve({ engine, port: 0, visibilityPollIntervalMs: 20 });

    try {
      await waitForRealTimersForTesting(320);

      expect(errorSpy).toHaveBeenCalledWith(
        '[weft] Reconciliation scanner error:',
        expect.any(Error),
      );
    } finally {
      restoreScan();
      errorSpy.mockRestore();
    }
  });

  it('logs and swallows event persistence failures', async () => {
    engine = createEngine();
    const consoleErrorSpy = spyOn(console, 'error').mockImplementation(() => {});
    const consoleWarnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    const originalPut = engine.storage.put.bind(engine.storage);
    let putAttempts = 0;

    engine.storage.put = async (...args) => {
      putAttempts++;
      if (putAttempts <= 2) {
        throw new Error('forced persistence failure');
      }
      return originalPut(...args);
    };

    try {
      const handle = wireEventBroadcasting(engine, { publish() {} } as never, {
        publishTokenMessage() {},
      });

      engine.dispatchEvent(new WorkflowCompletedEvent('wf-persist-failure', 'done', 1));

      await waitFor(() => consoleErrorSpy.mock.calls.length === 1, {
        label: 'event persistence failure log',
      });

      expect(
        consoleWarnSpy.mock.calls.some(([message]) => String(message).includes('Retrying')),
      ).toBe(true);
      expect(consoleErrorSpy.mock.calls[0]?.[0]).toContain(
        'Failed to persist event "workflow:completed" for workflow "wf-persist-failure"',
      );

      handle.dispose();
    } finally {
      consoleWarnSpy.mockRestore();
      consoleErrorSpy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// Concurrent scanner deduplication (regression: processingOperationIds)
// ---------------------------------------------------------------------------

describe('concurrent scanner deduplication', () => {
  let engine: Engine;
  let server: WeftServer;
  let storage: MemoryStorage;

  afterEach(async () => {
    await server?.stop();
    engine?.[Symbol.dispose]();
  });

  function createEngineWithStorage(): { engine: Engine; storage: MemoryStorage } {
    const s = new MemoryStorage();
    const e = new Engine({ storage: s });
    e.register(echoWorkflow);
    return { engine: e, storage: s };
  }

  async function connectWorker(wsServer: WeftServer): Promise<WebSocket> {
    const wsUrl = wsServer.url.replace('http://', 'ws://');
    const ws = new WebSocket(`${wsUrl}/v1/tasks/default/stream`);
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve());
      ws.addEventListener('error', () => reject(new Error('WebSocket connection failed')));
    });
    return ws;
  }

  async function registerWorker(
    ws: WebSocket,
    options: { workerId: string; activities: string[]; concurrency?: number },
  ): Promise<void> {
    ws.send(
      JSON.stringify({
        type: 'register',
        protocolVersion: 2,
        workerId: options.workerId,
        activities: options.activities,
        concurrency: options.concurrency ?? 10,
      }),
    );
    await waitForRealTimersForTesting(50);
  }

  it('does not double-process an operationId when scanExpiredTasks and reconcileOrphanedRecords overlap', async () => {
    // Regression test: before the processingOperationIds guard was added, both
    // scanExpiredTasks (fast heap-based path) and reconcileOrphanedRecords
    // (full storage scan) could call registry.completeTask() and
    // reassignOrExpireTask() for the same operationId concurrently, producing
    // duplicate re-dispatches and corrupt attempt counts.
    //
    // With visibilityPollIntervalMs: 50, the reconciliation scanner fires after
    // 50 * 12 = 600ms. By running both scanners for at least one full
    // reconciliation cycle, we verify that the same operationId is processed
    // exactly once per expiry event — not twice.
    ({ engine, storage } = createEngineWithStorage());
    server = serve({ engine, port: 0, visibilityPollIntervalMs: 50 });

    const ws = await connectWorker(server);
    const received: Array<{ type: string; operationId?: string; attempt?: number }> = [];

    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(String(event.data)) as {
        type: string;
        operationId?: string;
        attempt?: number;
      };
      received.push(msg);
      // Complete immediately on attempt 2 so the task does not keep cycling.
      if (msg.type === 'task' && (msg.attempt ?? 1) >= 2) {
        ws.send(
          JSON.stringify({
            type: 'taskResult',
            operationId: msg.operationId,
            status: 'completed',
            value: null,
          }),
        );
      }
    });

    await registerWorker(ws, { workerId: 'w1', activities: ['charge'], concurrency: 5 });

    // A short visibility timeout ensures the task expires before the first
    // reconciliation cycle, so both scanners see it as expired on their first
    // pass over the same operationId.
    await server.dispatchTask({
      operationId: 'dedup-scan-op',
      activityName: 'charge',
      input: null,
      visibilityTimeout: 60, // expires in 60ms, well before the 600ms reconciliation
    });
    await waitForRealTimersForTesting(50);
    expect(server.registry.isAssigned('dedup-scan-op')).toBe(true);

    // Wait for at least one full reconciliation cycle (600ms) plus some slack
    // so both scanners have had multiple chances to process the expired record.
    await waitForRealTimersForTesting(800);

    // The task must be re-dispatched exactly once (attempt 2). If the guard
    // were absent, the worker would receive attempt 2 more than once.
    const taskMessages = received.filter(
      (m) => m.type === 'task' && m.operationId === 'dedup-scan-op',
    );
    const attempt2Messages = taskMessages.filter((m) => m.attempt === 2);
    expect(attempt2Messages.length).toBe(1);

    ws.close();
    await waitForRealTimersForTesting(50);
  });

  it('does not double-process an orphaned operationId visible only to reconcileOrphanedRecords', async () => {
    // Insert an expired inflight record directly into storage without
    // dispatching through the server. This means the record is NOT in the
    // deadline heap, so only reconcileOrphanedRecords will find it — and it
    // will only find it once even if multiple reconciliation cycles run.
    ({ engine, storage } = createEngineWithStorage());
    server = serve({ engine, port: 0, visibilityPollIntervalMs: 50 });

    const ws = await connectWorker(server);
    const received: Array<{ type: string; operationId?: string; attempt?: number }> = [];

    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(String(event.data)) as {
        type: string;
        operationId?: string;
        attempt?: number;
      };
      received.push(msg);
      // Complete on first re-dispatch attempt to prevent further cycling.
      if (msg.type === 'task') {
        ws.send(
          JSON.stringify({
            type: 'taskResult',
            operationId: msg.operationId,
            status: 'completed',
            value: null,
          }),
        );
      }
    });

    await registerWorker(ws, { workerId: 'w1', activities: ['charge'], concurrency: 5 });

    // Wait for the server's startup restore scan to finish before inserting
    // the orphan so it is not accidentally restored as a valid in-flight task.
    await waitForRealTimersForTesting(100);

    const orphanRecord = {
      operationId: 'dedup-orphan-op',
      workerId: 'ghost-worker',
      deadline: Date.now() - 5_000, // already expired
      activityName: 'charge',
      queue: 'default',
      input: null,
      attempt: 1,
      visibilityTimeout: 30_000,
    };
    await storage.put(KEYS.operationInflight('dedup-orphan-op'), encode(orphanRecord));

    // Wait for two full reconciliation cycles (2 * 600ms = 1200ms) plus slack.
    // Without the deduplication guard a second concurrent reconciliation cycle
    // would re-dispatch the same record a second time.
    await waitForRealTimersForTesting(1400);

    // The orphaned task must be re-dispatched exactly once.
    const taskMessages = received.filter(
      (m) => m.type === 'task' && m.operationId === 'dedup-orphan-op',
    );
    expect(taskMessages.length).toBe(1);
    expect(taskMessages[0]?.attempt).toBe(2);

    ws.close();
    await waitForRealTimersForTesting(50);
  });

  it('re-adds a drained heap entry when reconciliation is already processing the same operation', async () => {
    const operationId = 'dedup-readd-op';
    const innerStorage = new MemoryStorage();

    let releaseBlockedBatch: () => void = () => {};
    const blockedBatch = new Promise<void>((resolve) => {
      releaseBlockedBatch = resolve;
    });
    let notifyReconciliationBlocked: () => void = () => {};
    const reconciliationBlocked = new Promise<void>((resolve) => {
      notifyReconciliationBlocked = resolve;
    });

    let shouldInjectExpiredEntry = false;
    let blockedOperationBatch = false;

    const delayedStorage: WeftStorage = {
      capabilities: innerStorage.capabilities.bind(innerStorage),
      get: innerStorage.get.bind(innerStorage),
      put: innerStorage.put.bind(innerStorage),
      delete: innerStorage.delete.bind(innerStorage),
      scan: innerStorage.scan.bind(innerStorage),
      batch: async (operations) => {
        const touchesTrackedOperation = operations.some(
          (operation) =>
            operation.key === KEYS.operationInflight(operationId) ||
            operation.key === KEYS.operationQueued(operationId),
        );

        if (!blockedOperationBatch && touchesTrackedOperation) {
          blockedOperationBatch = true;
          shouldInjectExpiredEntry = true;
          notifyReconciliationBlocked();
          await blockedBatch;
        }

        await innerStorage.batch(operations);
      },
      [Symbol.dispose]() {
        innerStorage[Symbol.dispose]();
      },
    };

    engine = new Engine({ storage: delayedStorage });
    engine.register(echoWorkflow);

    const originalAdd = DeadlineTracker.prototype.add;
    const originalDrainExpired = DeadlineTracker.prototype.drainExpired;
    let readdedEntries = 0;

    const restoreAdd = overrideProperty(
      DeadlineTracker.prototype,
      'add',
      function (
        this: DeadlineTracker,
        entry: Parameters<DeadlineTracker['add']>[0],
      ): ReturnType<DeadlineTracker['add']> {
        if (entry.operationId === operationId) {
          readdedEntries++;
        }
        return originalAdd.call(this, entry);
      },
    );

    const restoreDrainExpired = overrideProperty(
      DeadlineTracker.prototype,
      'drainExpired',
      function (
        this: DeadlineTracker,
        now: Parameters<DeadlineTracker['drainExpired']>[0],
      ): ReturnType<DeadlineTracker['drainExpired']> {
        const expired = originalDrainExpired.call(this, now);
        if (shouldInjectExpiredEntry) {
          shouldInjectExpiredEntry = false;
          return [...expired, { operationId, deadline: now - 1 }];
        }
        return expired;
      },
    );

    try {
      server = serve({ engine, port: 0, visibilityPollIntervalMs: 25 });
      await waitForRealTimersForTesting(100);

      await innerStorage.put(
        KEYS.operationInflight(operationId),
        encode({
          operationId,
          workerId: 'ghost-worker',
          deadline: Date.now() - 5_000,
          activityName: 'charge',
          queue: 'default',
          input: null,
          attempt: 1,
          visibilityTimeout: 30_000,
        }),
      );

      await reconciliationBlocked;

      let observedReadd = false;
      for (let attempt = 0; attempt < 20; attempt++) {
        await waitForRealTimersForTesting(25);
        observedReadd = readdedEntries > 0;
        if (observedReadd) break;
      }

      expect(observedReadd).toBe(true);
      expect(readdedEntries).toBe(1);

      releaseBlockedBatch();
      await waitForRealTimersForTesting(100);

      expect(await innerStorage.get(KEYS.operationQueued(operationId))).not.toBeNull();
    } finally {
      releaseBlockedBatch();
      restoreDrainExpired();
      restoreAdd();
    }
  });
});

// ---------------------------------------------------------------------------
// Retry policy respected on reassignment
// ---------------------------------------------------------------------------

describe('retry policy respected on reassignment', () => {
  let engine: Engine;
  let server: WeftServer;
  let storage: MemoryStorage;

  afterEach(async () => {
    await server?.stop();
    engine?.[Symbol.dispose]();
  });

  function createEngineWithStorage(): { engine: Engine; storage: MemoryStorage } {
    const s = new MemoryStorage();
    const e = new Engine({ storage: s });
    e.register(echoWorkflow);
    return { engine: e, storage: s };
  }

  async function connectWorker(
    wsServer: WeftServer,
    path = '/v1/tasks/default/stream',
  ): Promise<WebSocket> {
    const wsUrl = wsServer.url.replace('http://', 'ws://');
    const ws = new WebSocket(`${wsUrl}${path}`);
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve());
      ws.addEventListener('error', () => reject(new Error('WebSocket connection failed')));
    });
    return ws;
  }

  async function registerWorker(
    ws: WebSocket,
    options: { workerId: string; activities: string[]; concurrency?: number },
  ): Promise<void> {
    ws.send(
      JSON.stringify({
        type: 'register',
        protocolVersion: 2,
        workerId: options.workerId,
        activities: options.activities,
        concurrency: options.concurrency ?? 10,
      }),
    );
    await waitForRealTimersForTesting(50);
  }

  const testRetryPolicy: RetryPolicy = {
    maxAttempts: 2,
    initialBackoff: 100,
    backoffMultiplier: 2,
    maxBackoff: 5000,
  };

  it('does not re-dispatch when maxAttempts exceeded on visibility timeout expiry', async () => {
    ({ engine, storage } = createEngineWithStorage());
    server = serve({ engine, port: 0, visibilityPollIntervalMs: 50 });

    const ws = await connectWorker(server);
    const received: Array<{ type: string; operationId?: string; attempt?: number }> = [];
    ws.addEventListener('message', (event) => {
      received.push(JSON.parse(String(event.data)));
    });
    await registerWorker(ws, { workerId: 'w1', activities: ['charge'], concurrency: 5 });

    // Dispatch a task already at maxAttempts with a short visibility timeout
    await server.dispatchTask({
      operationId: 'max-attempt-expiry-op',
      activityName: 'charge',
      input: { amount: 42 },
      attempt: 2,
      visibilityTimeout: 100,
      retryPolicy: testRetryPolicy, // maxAttempts = 2, already at attempt 2
    });
    await waitFor(
      () =>
        received.some(
          (message) =>
            message.type === 'task' &&
            message.operationId === 'max-attempt-expiry-op' &&
            message.attempt === 2,
        ),
      { label: 'initial max-attempt-expiry-op dispatch' },
    );

    // Wait for the visibility timeout to expire and the scanner to run
    const inflightKey = KEYS.operationInflight('max-attempt-expiry-op');
    await waitFor(async () => (await storage.get(inflightKey)) === null, {
      timeoutMs: 1000,
      label: 'max-attempt-expiry-op inflight record cleanup',
    });

    // The task should NOT be re-dispatched — only the initial dispatch should exist
    const taskMessages = received.filter(
      (m) => m.type === 'task' && m.operationId === 'max-attempt-expiry-op',
    );
    expect(taskMessages.length).toBe(1);
    expect(taskMessages[0]?.attempt).toBe(2);

    // In-flight record should be cleaned up
    const record = await storage.get(inflightKey);
    expect(record).toBeNull();

    ws.close();
    await waitForRealTimersForTesting(50);
  });

  it('does not re-dispatch when maxAttempts exceeded on worker disconnect', async () => {
    ({ engine, storage } = createEngineWithStorage());
    server = serve({ engine, port: 0 });

    const ws1 = await connectWorker(server);
    const ws2 = await connectWorker(server);

    const received: Array<{ type: string; operationId?: string; attempt?: number }> = [];
    ws2.addEventListener('message', (event) => {
      received.push(JSON.parse(String(event.data)));
    });

    await registerWorker(ws1, { workerId: 'w1', activities: ['charge'], concurrency: 5 });
    await registerWorker(ws2, { workerId: 'w2', activities: ['charge'], concurrency: 5 });

    // Dispatch a task already at maxAttempts
    await server.dispatchTask({
      operationId: 'max-attempt-disconnect-op',
      activityName: 'charge',
      input: { amount: 42 },
      attempt: 2,
      retryPolicy: testRetryPolicy, // maxAttempts = 2, already at attempt 2
    });
    await waitForRealTimersForTesting(50);

    // Disconnect w1 — task should NOT be reassigned to w2 since maxAttempts reached
    ws1.close();
    await waitForRealTimersForTesting(200);

    const taskMessages = received.filter(
      (m) => m.type === 'task' && m.operationId === 'max-attempt-disconnect-op',
    );
    expect(taskMessages.length).toBe(0);

    // In-flight record should be cleaned up
    const inflightKey = KEYS.operationInflight('max-attempt-disconnect-op');
    const record = await storage.get(inflightKey);
    expect(record).toBeNull();

    ws2.close();
    await waitForRealTimersForTesting(50);
  });

  it('re-dispatches when within maxAttempts on visibility timeout expiry', async () => {
    ({ engine, storage } = createEngineWithStorage());
    server = serve({ engine, port: 0, visibilityPollIntervalMs: 50 });

    const ws = await connectWorker(server);
    const received: Array<{ type: string; operationId?: string; attempt?: number }> = [];
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(String(event.data)) as {
        type: string;
        operationId?: string;
        attempt?: number;
      };
      received.push(msg);
      // Complete on attempt 2 to stop reassignment cycle
      if (msg.type === 'task' && (msg.attempt ?? 1) >= 2) {
        ws.send(
          JSON.stringify({
            type: 'taskResult',
            operationId: msg.operationId,
            status: 'completed',
            value: null,
          }),
        );
      }
    });
    await registerWorker(ws, { workerId: 'w1', activities: ['charge'], concurrency: 5 });

    // maxAttempts = 3, starting at attempt 1 — should allow reassignment
    await server.dispatchTask({
      operationId: 'within-limit-expiry-op',
      activityName: 'charge',
      input: null,
      visibilityTimeout: 100,
      retryPolicy: { ...testRetryPolicy, maxAttempts: 3 },
    });
    await waitForRealTimersForTesting(50);

    // Wait for the visibility timeout to expire and the scanner to re-dispatch
    await waitForRealTimersForTesting(300);

    const taskMessages = received.filter(
      (m) => m.type === 'task' && m.operationId === 'within-limit-expiry-op',
    );
    expect(taskMessages.length).toBeGreaterThanOrEqual(2);
    expect(taskMessages[0]?.attempt).toBe(1);
    expect(taskMessages[1]?.attempt).toBe(2);

    ws.close();
    await waitForRealTimersForTesting(50);
  });

  it('applies backoff delay before re-dispatch on visibility timeout expiry', async () => {
    ({ engine, storage } = createEngineWithStorage());
    server = serve({ engine, port: 0, visibilityPollIntervalMs: 50 });

    const ws = await connectWorker(server);
    const timestamps: number[] = [];
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(String(event.data)) as {
        type: string;
        operationId?: string;
        attempt?: number;
      };
      if (msg.type === 'task' && msg.operationId === 'backoff-expiry-op') {
        timestamps.push(Date.now());
        // Complete on attempt 2 to stop the cycle
        if ((msg.attempt ?? 1) >= 2) {
          ws.send(
            JSON.stringify({
              type: 'taskResult',
              operationId: msg.operationId,
              status: 'completed',
              value: null,
            }),
          );
        }
      }
    });
    await registerWorker(ws, { workerId: 'w1', activities: ['charge'], concurrency: 5 });

    // initialBackoff = 100ms
    await server.dispatchTask({
      operationId: 'backoff-expiry-op',
      activityName: 'charge',
      input: null,
      visibilityTimeout: 80,
      retryPolicy: { ...testRetryPolicy, maxAttempts: 3, initialBackoff: 100 },
    });

    // Wait long enough for: visibility timeout (80ms) + backoff (100ms) + scanner intervals
    await waitForRealTimersForTesting(500);

    // Should have received both dispatches
    expect(timestamps.length).toBeGreaterThanOrEqual(2);

    // The gap between dispatch 1 and dispatch 2 should be at least ~80ms (visibility) + ~100ms (backoff)
    // We use a conservative lower bound to account for timing variability
    const gap = timestamps[1]! - timestamps[0]!;
    expect(gap).toBeGreaterThanOrEqual(150);

    ws.close();
    await waitForRealTimersForTesting(50);
  });

  it('applies backoff delay before re-dispatch on worker disconnect', async () => {
    ({ engine, storage } = createEngineWithStorage());
    server = serve({ engine, port: 0 });

    const ws1 = await connectWorker(server);
    const ws2 = await connectWorker(server);

    const timestamps: number[] = [];
    ws2.addEventListener('message', (event) => {
      const msg = JSON.parse(String(event.data)) as {
        type: string;
        operationId?: string;
        attempt?: number;
      };
      if (msg.type === 'task' && msg.operationId === 'backoff-disconnect-op') {
        timestamps.push(Date.now());
      }
    });

    await registerWorker(ws1, { workerId: 'w1', activities: ['charge'], concurrency: 5 });
    await registerWorker(ws2, { workerId: 'w2', activities: ['charge'], concurrency: 5 });

    const dispatchTime = Date.now();
    // initialBackoff = 150ms, attempt 1 → backoff for attempt 2 = 150ms
    await server.dispatchTask({
      operationId: 'backoff-disconnect-op',
      activityName: 'charge',
      input: null,
      retryPolicy: { ...testRetryPolicy, maxAttempts: 3, initialBackoff: 150 },
    });
    await waitForRealTimersForTesting(50);

    // Disconnect w1 — should apply backoff before re-dispatching to w2
    ws1.close();

    // Wait for the backoff delay to complete
    await waitForRealTimersForTesting(400);

    expect(timestamps.length).toBe(1);
    // The re-dispatch should have been delayed by at least the backoff (150ms)
    const gap = timestamps[0]! - dispatchTime;
    expect(gap).toBeGreaterThanOrEqual(150);

    ws2.close();
    await waitForRealTimersForTesting(50);
  });

  it('logs delayed redispatch failures when backoff requeue dispatch throws', async () => {
    ({ engine, storage } = createEngineWithStorage());
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
    const originalPut = storage.put.bind(storage);
    server = serve({ engine, port: 0 });

    const restorePut = overrideProperty(storage, 'put', (async (key: string, value: Uint8Array) => {
      if (key === KEYS.operationQueued('delayed-redispatch-fail-op')) {
        throw new Error('delayed redispatch failed');
      }
      await originalPut(key, value);
    }) as MemoryStorage['put']);

    try {
      const ws = await connectWorker(server);
      await registerWorker(ws, { workerId: 'w-delayed-redispatch', activities: ['charge'] });

      await server.dispatchTask({
        operationId: 'delayed-redispatch-fail-op',
        activityName: 'charge',
        input: null,
        retryPolicy: { ...testRetryPolicy, maxAttempts: 3, initialBackoff: 50, maxBackoff: 50 },
      });
      await waitForRealTimersForTesting(50);

      ws.close();

      // Poll for the delayed-redispatch error log rather than waiting a fixed
      // 250ms and asserting immediately: under parallel load the backoff requeue
      // can land later than any fixed window, which made this test flaky in the
      // pre-commit full-suite run. The poll adapts to the real timing, and the
      // full `toHaveBeenCalledWith` contract (including the Error argument) is
      // still asserted afterward so polling can't mask a wrong-shaped call.
      await waitFor(
        () =>
          errorSpy.mock.calls.some(
            (call) =>
              call[0] === '[weft] Delayed redispatch failed for "delayed-redispatch-fail-op":',
          ),
        { label: 'delayed redispatch error log' },
      );

      expect(errorSpy).toHaveBeenCalledWith(
        '[weft] Delayed redispatch failed for "delayed-redispatch-fail-op":',
        expect.any(Error),
      );
    } finally {
      restorePut();
      errorSpy.mockRestore();
    }
  });

  it('stores retryPolicy in the inflight record for use during reassignment', async () => {
    ({ engine, storage } = createEngineWithStorage());
    server = serve({ engine, port: 0 });

    const ws = await connectWorker(server);
    await registerWorker(ws, { workerId: 'w1', activities: ['charge'], concurrency: 5 });

    await server.dispatchTask({
      operationId: 'policy-stored-op',
      activityName: 'charge',
      input: null,
      retryPolicy: testRetryPolicy,
    });
    await waitForRealTimersForTesting(50);

    const inflightKey = KEYS.operationInflight('policy-stored-op');
    const raw = await storage.get(inflightKey);
    expect(raw).not.toBeNull();

    const record = decode(raw!) as { retryPolicy: RetryPolicy };
    expect(record.retryPolicy).toEqual(testRetryPolicy);

    ws.close();
    await waitForRealTimersForTesting(50);
  });

  it('defaults to no maxAttempts limit when retryPolicy is not provided', async () => {
    ({ engine, storage } = createEngineWithStorage());
    server = serve({ engine, port: 0, visibilityPollIntervalMs: 50 });

    const ws = await connectWorker(server);
    const received: Array<{ type: string; operationId?: string; attempt?: number }> = [];
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(String(event.data)) as {
        type: string;
        operationId?: string;
        attempt?: number;
      };
      received.push(msg);
      // Complete on attempt 2 to stop the cycle
      if (msg.type === 'task' && (msg.attempt ?? 1) >= 2) {
        ws.send(
          JSON.stringify({
            type: 'taskResult',
            operationId: msg.operationId,
            status: 'completed',
            value: null,
          }),
        );
      }
    });
    await registerWorker(ws, { workerId: 'w1', activities: ['charge'], concurrency: 5 });

    // No retryPolicy — should still re-dispatch (backwards compatible)
    await server.dispatchTask({
      operationId: 'no-policy-op',
      activityName: 'charge',
      input: null,
      visibilityTimeout: 100,
    });
    await waitForRealTimersForTesting(50);

    // Wait for visibility timeout expiry + scanner
    await waitForRealTimersForTesting(300);

    const taskMessages = received.filter(
      (m) => m.type === 'task' && m.operationId === 'no-policy-op',
    );
    expect(taskMessages.length).toBeGreaterThanOrEqual(2);

    ws.close();
    await waitForRealTimersForTesting(50);
  });
});

// ---------------------------------------------------------------------------
// Worker shutdown and cancel propagation
// ---------------------------------------------------------------------------

describe('worker shutdown and cancel propagation', () => {
  let engine: Engine;
  let server: WeftServer;

  afterEach(async () => {
    await server?.stop();
    engine?.[Symbol.dispose]();
  });

  async function connectWorker(
    wsServer: WeftServer,
    path = '/v1/tasks/default/stream',
  ): Promise<WebSocket> {
    const wsUrl = wsServer.url.replace('http://', 'ws://');
    const ws = new WebSocket(`${wsUrl}${path}`);
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve());
      ws.addEventListener('error', () => reject(new Error('WebSocket connection failed')));
    });
    return ws;
  }

  async function registerWorker(
    ws: WebSocket,
    options: { workerId: string; activities: string[]; concurrency?: number },
  ): Promise<void> {
    ws.send(
      JSON.stringify({
        type: 'register',
        protocolVersion: 2,
        workerId: options.workerId,
        activities: options.activities,
        concurrency: options.concurrency ?? 10,
      }),
    );
    await waitForRealTimersForTesting(50);
  }

  it('shutdownWorker sends shutdown message and waits for disconnect', async () => {
    engine = createEngine();
    server = serve({ engine, port: 0 });

    const received: Array<{ type: string; [key: string]: unknown }> = [];
    const ws = await connectWorker(server);

    ws.addEventListener('message', (event) => {
      const parsed = JSON.parse(String(event.data)) as { type: string; [key: string]: unknown };
      received.push(parsed);

      // Simulate worker receiving shutdown and closing the connection
      if (parsed.type === 'shutdown') {
        ws.close();
      }
    });

    await registerWorker(ws, { workerId: 'shutdown-w1', activities: ['charge'], concurrency: 5 });

    const result = await server.shutdownWorker('shutdown-w1', { timeoutMs: 5000 });

    expect(result).toBe(true);

    const shutdownMessage = received.find((m) => m.type === 'shutdown');
    expect(shutdownMessage).toBeDefined();

    // The worker should be unregistered after disconnect
    await waitForRealTimersForTesting(50);
    expect(server.registry.getWorker('shutdown-w1')).toBeUndefined();
  });

  it('shutdownWorker returns after the timeout when the worker stays connected', async () => {
    engine = createEngine();
    server = serve({ engine, port: 0 });

    const ws = await connectWorker(server);
    await registerWorker(ws, { workerId: 'shutdown-timeout-w1', activities: ['charge'] });

    const result = await server.shutdownWorker('shutdown-timeout-w1', { timeoutMs: 50 });

    expect(result).toBe(true);
    expect(server.registry.getWorker('shutdown-timeout-w1')).toBeDefined();

    ws.close();
    await waitForRealTimersForTesting(50);
  });

  it('shutdownWorker returns false for unknown worker', async () => {
    engine = createEngine();
    server = serve({ engine, port: 0 });

    const result = await server.shutdownWorker('non-existent-worker');
    expect(result).toBe(false);
  });

  it('shutdownAllWorkers shuts down all connected workers', async () => {
    engine = createEngine();
    server = serve({ engine, port: 0 });

    const ws1 = await connectWorker(server);
    const ws2 = await connectWorker(server);

    // Auto-close on receiving shutdown
    ws1.addEventListener('message', (event) => {
      const parsed = JSON.parse(String(event.data)) as { type: string };
      if (parsed.type === 'shutdown') ws1.close();
    });
    ws2.addEventListener('message', (event) => {
      const parsed = JSON.parse(String(event.data)) as { type: string };
      if (parsed.type === 'shutdown') ws2.close();
    });

    await registerWorker(ws1, { workerId: 'all-w1', activities: ['charge'], concurrency: 5 });
    await registerWorker(ws2, { workerId: 'all-w2', activities: ['charge'], concurrency: 5 });

    expect(server.registry.size).toBe(2);

    await server.shutdownAllWorkers({ timeoutMs: 5000 });

    await waitForRealTimersForTesting(50);
    expect(server.registry.size).toBe(0);
  });

  it('falls back to the long-poll queue when a registry worker has no live socket', async () => {
    engine = createEngine();
    server = serve({ engine, port: 0 });

    server.registry.register({
      id: 'ghost-worker',
      queue: 'default',
      activities: ['charge'],
      concurrency: 1,
    });

    const dispatched = await server.dispatchTask({
      operationId: 'ghost-worker-op',
      activityName: 'charge',
      input: null,
    });

    expect(dispatched).toBe(true);
    expect(server.taskQueue.pendingCount('default')).toBe(1);
  });

  it('cancelTask sends cancel to the correct worker', async () => {
    engine = createEngine();
    server = serve({ engine, port: 0 });

    const received: Array<{ type: string; operationId?: string }> = [];
    const ws = await connectWorker(server);

    ws.addEventListener('message', (event) => {
      received.push(JSON.parse(String(event.data)));
    });

    await registerWorker(ws, { workerId: 'cancel-w1', activities: ['charge'], concurrency: 5 });

    await server.dispatchTask({
      operationId: 'cancel-op-1',
      activityName: 'charge',
      input: { amount: 100 },
    });
    await waitForRealTimersForTesting(50);

    const result = server.cancelTask('cancel-op-1');

    expect(result).toBe(true);
    await waitForRealTimersForTesting(50);

    const cancelMessage = received.find((m) => m.type === 'cancel');
    expect(cancelMessage).toBeDefined();
    expect(cancelMessage!.operationId).toBe('cancel-op-1');

    ws.close();
    await waitForRealTimersForTesting(50);
  });

  it('cancelTask returns false when no worker has the task', async () => {
    engine = createEngine();
    server = serve({ engine, port: 0 });

    const result = server.cancelTask('non-existent-op');
    expect(result).toBe(false);
  });

  it('workflow cancellation propagates cancel to workers', async () => {
    engine = createEngine();
    server = serve({ engine, port: 0 });

    const received: Array<{ type: string; operationId?: string }> = [];
    const ws = await connectWorker(server);

    ws.addEventListener('message', (event) => {
      received.push(JSON.parse(String(event.data)));
    });

    await registerWorker(ws, { workerId: 'wf-cancel-w1', activities: ['charge'], concurrency: 5 });

    // Dispatch a task with a workflowId so it gets indexed in workflowOperations
    await server.dispatchTask({
      operationId: 'wf-cancel-op-1',
      activityName: 'charge',
      input: { amount: 100 },
      workflowId: 'workflow-to-cancel',
    });
    await waitForRealTimersForTesting(50);

    // Simulate workflow cancellation by dispatching the event on the engine
    const { WorkflowCancelledEvent: CancelledEvent } = await import('../core/events.ts');
    engine.dispatchEvent(new CancelledEvent('workflow-to-cancel'));

    await waitForRealTimersForTesting(100);

    const cancelMessages = received.filter((m) => m.type === 'cancel');
    expect(cancelMessages.length).toBe(1);
    expect(cancelMessages[0]!.operationId).toBe('wf-cancel-op-1');

    ws.close();
    await waitForRealTimersForTesting(50);
  });
});

describe('header propagation in task dispatch', () => {
  let engine: Engine;
  let server: WeftServer;

  afterEach(async () => {
    await server?.stop();
    engine?.[Symbol.dispose]();
  });

  async function connectWorker(
    wsServer: WeftServer,
    path = '/v1/tasks/default/stream',
  ): Promise<WebSocket> {
    const wsUrl = wsServer.url.replace('http://', 'ws://');
    const ws = new WebSocket(`${wsUrl}${path}`);
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve());
      ws.addEventListener('error', () => reject(new Error('WebSocket connection failed')));
    });
    return ws;
  }

  async function registerWorker(
    ws: WebSocket,
    options: { workerId: string; activities: string[]; concurrency?: number },
  ): Promise<void> {
    ws.send(
      JSON.stringify({
        type: 'register',
        protocolVersion: 2,
        workerId: options.workerId,
        activities: options.activities,
        concurrency: options.concurrency ?? 10,
      }),
    );
    await waitForRealTimersForTesting(50);
  }

  it('includes headers when dispatching to WebSocket workers', async () => {
    engine = createEngine();
    server = serve({ engine, port: 0 });

    const received: Array<Record<string, unknown>> = [];
    const ws = await connectWorker(server);

    ws.addEventListener('message', (event) => {
      received.push(JSON.parse(String(event.data)) as Record<string, unknown>);
    });

    await registerWorker(ws, { workerId: 'header-w1', activities: ['charge'], concurrency: 5 });

    await server.dispatchTask({
      operationId: 'header-op-1',
      activityName: 'charge',
      input: { amount: 100 },
      headers: { 'x-trace-id': 'trace-123', 'x-auth': 'bearer-token' },
    });

    await waitForRealTimersForTesting(100);

    const taskMessage = received.find((m) => m['type'] === 'task');
    expect(taskMessage).toBeDefined();
    expect(taskMessage!['headers']).toEqual({
      'x-trace-id': 'trace-123',
      'x-auth': 'bearer-token',
    });

    ws.close();
    await waitForRealTimersForTesting(50);
  });

  it('omits headers field when no headers are provided', async () => {
    engine = createEngine();
    server = serve({ engine, port: 0 });

    const received: Array<Record<string, unknown>> = [];
    const ws = await connectWorker(server);

    ws.addEventListener('message', (event) => {
      received.push(JSON.parse(String(event.data)) as Record<string, unknown>);
    });

    await registerWorker(ws, {
      workerId: 'no-header-w1',
      activities: ['charge'],
      concurrency: 5,
    });

    await server.dispatchTask({
      operationId: 'no-header-op-1',
      activityName: 'charge',
      input: { amount: 50 },
    });

    await waitForRealTimersForTesting(100);

    const taskMessage = received.find((m) => m['type'] === 'task');
    expect(taskMessage).toBeDefined();
    expect(taskMessage!['headers']).toBeUndefined();

    ws.close();
    await waitForRealTimersForTesting(50);
  });

  it('includes headers when dispatching to long-poll workers via task queue', async () => {
    engine = createEngine();
    server = serve({ engine, port: 0 });

    // Dispatch task with headers — it will go into the task queue since no
    // WebSocket worker is connected for the target activity
    await server.dispatchTask({
      operationId: 'lp-header-op-1',
      activityName: 'unregistered-activity',
      input: { data: 'test' },
      headers: { 'x-request-id': 'req-456' },
    });

    // Poll the task queue via the long-poll HTTP endpoint
    const baseUrl = server.url;
    const response = await fetch(`${baseUrl}/v1/tasks/default?activity=unregistered-activity`, {
      method: 'GET',
      headers: { 'X-Long-Poll-Timeout': '500' },
    });

    expect(response.status).toBe(200);
    const task = (await response.json()) as Record<string, unknown>;
    expect(task['operationId']).toBe('lp-header-op-1');
    expect(task['headers']).toEqual({ 'x-request-id': 'req-456' });
  });

  it('propagates headers end-to-end to a RemoteWorker activity interceptor', async () => {
    engine = createEngine();
    server = serve({ engine, port: 0 });

    const { RemoteWorker } = await import('../worker/index.ts');

    let capturedHeaders: Map<string, string> | undefined;

    const interceptor: import('../core/interceptor.ts').ActivityInterceptor = {
      execute(context, next) {
        capturedHeaders = context.headers;
        return next(context);
      },
    };

    const worker = new RemoteWorker({
      serverUrl: `ws://localhost:${server.port}/v1/tasks/default/stream`,
      workerId: 'header-e2e-worker',
      activities: {
        echo: async (input: unknown) => input,
      },
      interceptors: [interceptor],
      concurrency: 3,
    });

    await worker.connect();
    await waitForRealTimersForTesting(50);

    expect(server.registry.size).toBe(1);

    const dispatched = await server.dispatchTask({
      operationId: 'header-e2e-op-1',
      activityName: 'echo',
      input: 'payload',
      headers: { 'x-trace-id': 'trace-e2e-789', 'x-custom': 'value-42' },
    });
    expect(dispatched).toBe(true);

    // Wait for the worker to process the task through its interceptor chain
    await waitForRealTimersForTesting(300);

    // The interceptor should have captured the headers as a Map
    expect(capturedHeaders).toBeDefined();
    expect(capturedHeaders!.get('x-trace-id')).toBe('trace-e2e-789');
    expect(capturedHeaders!.get('x-custom')).toBe('value-42');

    // The task should have completed successfully
    expect(server.registry.getAll()[0]?.inFlight).toBe(0);

    await worker.disconnect();
    await waitForRealTimersForTesting(50);
  });

  it('propagates empty headers map to interceptor when dispatch includes no headers', async () => {
    engine = createEngine();
    server = serve({ engine, port: 0 });

    const { RemoteWorker } = await import('../worker/index.ts');

    let capturedHeaders: Map<string, string> | undefined;

    const interceptor: import('../core/interceptor.ts').ActivityInterceptor = {
      execute(context, next) {
        capturedHeaders = context.headers;
        return next(context);
      },
    };

    const worker = new RemoteWorker({
      serverUrl: `ws://localhost:${server.port}/v1/tasks/default/stream`,
      workerId: 'header-e2e-no-headers',
      activities: {
        echo: async (input: unknown) => input,
      },
      interceptors: [interceptor],
      concurrency: 3,
    });

    await worker.connect();
    await waitForRealTimersForTesting(50);

    await server.dispatchTask({
      operationId: 'header-e2e-no-op',
      activityName: 'echo',
      input: 'payload',
    });

    await waitForRealTimersForTesting(300);

    // The interceptor should still receive a headers Map, just empty
    expect(capturedHeaders).toBeDefined();
    expect(capturedHeaders!.size).toBe(0);

    await worker.disconnect();
    await waitForRealTimersForTesting(50);
  });
});
