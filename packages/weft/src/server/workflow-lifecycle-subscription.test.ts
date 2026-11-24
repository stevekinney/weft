import { MemoryStorage } from "../embedded/storage/src/index.ts";
import { afterEach, describe, expect, it } from 'bun:test';
import { AUTHORIZATION_SCOPES } from '../authorization-scopes.ts';

import { parseServerSentEventChunk } from "../embedded/backchannel/src/client/index.ts";
import { headerCarryingWebSocketFactory } from '../client/event-stream-transport.ts';
import { HttpClient } from '../client/index.ts';
import { Engine } from '../core/engine.ts';
import { workflow } from '../core/types.ts';
import { serve, type WeftServer } from './index.ts';

/**
 * COR-1905: a subscriber on the Server-Sent Events fallback must see the same lifecycle events,
 * in the same order and with the same cursors, as one on the `/watch` WebSocket. Each scenario
 * below runs over both transports against one real `serve()` with an API key.
 */

const API_KEY = 'lifecycle-subscription-key';
const TERMINAL_TYPES: ReadonlySet<string> = new Set(['workflow:completed', 'workflow:failed']);

const quick = workflow({ name: 'lifecycle-quick' }).execute(async function* (
  _context,
  input: string,
) {
  await Promise.resolve();
  return `done:${input}`;
});

const gated = workflow({ name: 'lifecycle-gated' }).execute(async function* (
  context,
  input: string,
) {
  const signal = yield* context.waitForSignal<string>('go');
  return `${input}:${signal}`;
});

type Transport = 'sse' | 'websocket';
const TRANSPORTS: readonly Transport[] = ['sse', 'websocket'];

type ObservedEvent = { readonly type: string; readonly cursor: string };

type Observation = {
  readonly events: ObservedEvent[];
  /** Resolves once the subscription is attached and its replay has been delivered. */
  readonly ready: Promise<void>;
  /** Resolves once a terminal lifecycle event has been delivered. */
  readonly terminal: Promise<void>;
  close(): void;
};

const servers: WeftServer[] = [];
const engines: Engine[] = [];
const observations: Observation[] = [];

afterEach(async () => {
  for (const observation of observations.splice(0)) observation.close();
  for (const server of servers.splice(0)) await server.stop();
  for (const engine of engines.splice(0)) await engine[Symbol.asyncDispose]();
});

function startServer(): { server: WeftServer; engine: Engine } {
  const engine = new Engine({ storage: new MemoryStorage() });
  engine.register(quick);
  engine.register(gated);
  engines.push(engine);
  const server = serve({
    engine,
    port: 0,
    auth: { apiKeys: [API_KEY], defaultApiKeyScopes: AUTHORIZATION_SCOPES },
  });
  servers.push(server);
  return { server, engine };
}

function authorizationHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${API_KEY}` };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function observeSse(server: WeftServer, workflowId: string, fromCursor?: string): Observation {
  const events: ObservedEvent[] = [];
  const ready = Promise.withResolvers<void>();
  const terminal = Promise.withResolvers<void>();
  const controller = new AbortController();
  const url = new URL(`${server.url}/v1/workflows/${encodeURIComponent(workflowId)}/events/sse`);
  if (fromCursor !== undefined) url.searchParams.set('fromCursor', fromCursor);

  void (async () => {
    const response = await fetch(url, {
      headers: { ...authorizationHeaders(), Accept: 'text/event-stream' },
      signal: controller.signal,
    });
    if (!response.ok || response.body === null) {
      ready.reject(new Error(`SSE subscription failed with status ${response.status}`));
      return;
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let remainder = '';
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) return;
      const parsed = parseServerSentEventChunk(
        decoder.decode(chunk.value, { stream: true }),
        remainder,
      );
      remainder = parsed.remainder;
      for (const frame of parsed.frames) {
        const data: unknown = JSON.parse(frame.data === '' ? 'null' : frame.data);
        if (frame.event === 'ping') {
          if (isRecord(data) && data['replayComplete'] === true) ready.resolve();
          continue;
        }
        if (!isRecord(data) || typeof data['kind'] !== 'string') continue;
        if (typeof data['cursor'] !== 'string') continue;
        events.push({ type: data['kind'], cursor: data['cursor'] });
        if (TERMINAL_TYPES.has(data['kind'])) terminal.resolve();
      }
    }
  })().catch((error: unknown) => {
    if (controller.signal.aborted) return;
    ready.reject(error);
    terminal.reject(error);
  });

  return {
    events,
    ready: ready.promise,
    terminal: terminal.promise,
    close: () => controller.abort(),
  };
}

function observeWebSocket(
  server: WeftServer,
  workflowId: string,
  resumeFrom?: string,
): Observation {
  const events: ObservedEvent[] = [];
  const ready = Promise.withResolvers<void>();
  const terminal = Promise.withResolvers<void>();
  const url = new URL(
    `${server.url.replace(/^http/, 'ws')}/v1/workflows/${encodeURIComponent(workflowId)}/watch`,
  );
  if (resumeFrom !== undefined) url.searchParams.set('resumeFrom', resumeFrom);
  const socket = headerCarryingWebSocketFactory(url.toString(), authorizationHeaders());
  socket.addEventListener('open', () => ready.resolve());
  socket.addEventListener('error', () => {
    ready.reject(new Error('WebSocket subscription failed'));
  });
  socket.addEventListener('message', (message) => {
    const data: unknown = JSON.parse(String(message.data));
    if (!isRecord(data) || typeof data['type'] !== 'string') return;
    if (typeof data['cursor'] !== 'string') return;
    events.push({ type: data['type'], cursor: data['cursor'] });
    if (TERMINAL_TYPES.has(data['type'])) terminal.resolve();
  });
  return {
    events,
    ready: ready.promise,
    terminal: terminal.promise,
    close: () => socket.close(),
  };
}

function observe(
  transport: Transport,
  server: WeftServer,
  workflowId: string,
  fromCursor?: string,
): Observation {
  const observation =
    transport === 'sse'
      ? observeSse(server, workflowId, fromCursor)
      : observeWebSocket(server, workflowId, fromCursor);
  observations.push(observation);
  return observation;
}

async function runToCompletion(server: WeftServer, workflowId: string): Promise<void> {
  const client = new HttpClient({ baseUrl: server.url, headers: authorizationHeaders() });
  const handle = await client.start('lifecycle-quick', workflowId, { id: workflowId });
  expect(await handle.result()).toBe(`done:${workflowId}`);
}

describe('workflow lifecycle subscription parity (COR-1905)', () => {
  describe.each(TRANSPORTS)('over %s', (transport) => {
    it('delivers workflow:started through workflow:completed in order when subscribed before the run starts', async () => {
      const { server } = startServer();
      const observation = observe(transport, server, 'before-start');
      await observation.ready;

      await runToCompletion(server, 'before-start');
      await observation.terminal;

      const types = observation.events.map((event) => event.type);
      expect(types[0]).toBe('workflow:started');
      expect(types.at(-1)).toBe('workflow:completed');
      const cursors = observation.events.map((event) => Number(event.cursor));
      expect(cursors).toEqual(cursors.toSorted((left, right) => left - right));
      expect(new Set(cursors).size).toBe(cursors.length);
    });

    it('replays the stored lifecycle events to a subscriber that attaches after completion', async () => {
      const { server } = startServer();
      await runToCompletion(server, 'after-completion');

      const observation = observe(transport, server, 'after-completion');
      await observation.terminal;

      const types = observation.events.map((event) => event.type);
      expect(types[0]).toBe('workflow:started');
      expect(types.at(-1)).toBe('workflow:completed');
    });
  });

  it('delivers identical events, order, and cursors over both transports for the same run', async () => {
    const { server } = startServer();
    const sse = observe('sse', server, 'parity');
    const webSocket = observe('websocket', server, 'parity');
    await Promise.all([sse.ready, webSocket.ready]);

    await runToCompletion(server, 'parity');
    await Promise.all([sse.terminal, webSocket.terminal]);

    expect(sse.events.length).toBeGreaterThanOrEqual(2);
    expect(sse.events).toEqual(webSocket.events);
  });

  it('resumes from a cursor on both transports with no gap and no duplicate', async () => {
    const { server } = startServer();
    await runToCompletion(server, 'resume');
    const full = observe('websocket', server, 'resume');
    await full.terminal;
    expect(full.events.length).toBeGreaterThanOrEqual(2);
    const midRun = full.events[0]!;

    for (const transport of TRANSPORTS) {
      const resumed = observe(transport, server, 'resume', midRun.cursor);
      await resumed.terminal;
      expect(resumed.events).toEqual(full.events.slice(1));
    }
  });

  it('rejects a subscriber that presents no API key on either transport', async () => {
    const { server } = startServer();
    const sse = await fetch(`${server.url}/v1/workflows/unauthenticated/events/sse`, {
      headers: { Accept: 'text/event-stream' },
    });
    expect(sse.status).toBe(401);
    await sse.body?.cancel();

    const socket = new WebSocket(`${server.url.replace(/^http/, 'ws')}/v1/workflows/x/watch`);
    const opened = await new Promise<boolean>((resolve) => {
      socket.addEventListener('open', () => resolve(true));
      socket.addEventListener('error', () => resolve(false));
      socket.addEventListener('close', () => resolve(false));
    });
    expect(opened).toBe(false);
  });

  describe.each(TRANSPORTS)('HttpClient with an API key over %s', (transport) => {
    it('fires workflow:started and workflow:completed listeners for a run that completes', async () => {
      const { server } = startServer();
      const client = new HttpClient({
        baseUrl: server.url,
        headers: authorizationHeaders(),
        eventTransport: transport === 'sse' ? 'sse' : 'websocket',
        ...(transport === 'websocket' ? { webSocketCarriesHeaders: true } : {}),
      });
      const handle = await client.start('lifecycle-gated', 'client-run', { id: 'client-run' });
      const seen: string[] = [];
      const completed = Promise.withResolvers<void>();
      handle.addEventListener('workflow:started', () => seen.push('workflow:started'));
      handle.addEventListener('workflow:completed', () => {
        seen.push('workflow:completed');
        completed.resolve();
      });
      await handle.whenConnected();
      await handle.signal('go', 'now');
      await completed.promise;

      expect(seen).toEqual(['workflow:started', 'workflow:completed']);
    });
  });
});
