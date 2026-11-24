import { z } from 'zod';

import type { AuthContext } from '../authentication.ts';
import { defineOperation } from '../operation-registry.ts';
import type { ServerSentEventTimerScheduler } from '../operations/sse-stream.ts';
import { principalFromApiKey } from '../principal.ts';

export type TestEvent = {
  readonly kind: string;
  readonly cursor: string;
  readonly emittedAtMs: number;
  readonly payload: Record<string, unknown>;
};

/** A replayable, followable feed with no Engine behind it. Cursor `n` means "n events seen". */
export function createTestFeed() {
  const events: TestEvent[] = [];
  const wakeups = new Set<() => void>();
  return {
    events,
    publish(kind: string): TestEvent {
      const event: TestEvent = {
        kind,
        cursor: String(events.length + 1),
        emittedAtMs: events.length + 1,
        payload: { kind },
      };
      events.push(event);
      for (const wake of wakeups) wake();
      return event;
    },
    subscribe(fromCursor: string | undefined, signal: AbortSignal): AsyncIterable<TestEvent> {
      return {
        async *[Symbol.asyncIterator]() {
          let index = fromCursor === undefined ? 0 : Number(fromCursor);
          while (!signal.aborted) {
            const next = events[index];
            if (next !== undefined) {
              index += 1;
              yield next;
              continue;
            }
            await new Promise<void>((resolve) => {
              const wake = (): void => {
                wakeups.delete(wake);
                signal.removeEventListener('abort', wake);
                resolve();
              };
              wakeups.add(wake);
              signal.addEventListener('abort', wake, { once: true });
            });
          }
        },
      };
    },
  };
}

/** The host the handler tests give their operations. */
export type TestHost = {
  /** The feed the test subscriptions read. */
  readonly feed: ReturnType<typeof createTestFeed>;
  /** Every input a subscription's `invoke` received, after the pipeline parsed it. */
  readonly seenInputs: unknown[];
  /** How many subscriptions the host saw closed. */
  readonly closed: { count: number };
};

/** Creates a fresh {@link TestHost}. */
export function createTestHost(): TestHost {
  return { feed: createTestFeed(), seenInputs: [], closed: { count: 0 } };
}

const eventsInput = z.object({
  topic: z.string().optional(),
  kinds: z.union([z.string(), z.array(z.string())]).optional(),
  fromCursor: z.string().min(1).optional(),
});

/** The event schema the test subscriptions declare. */
export const testEventSchema = z.object({
  kind: z.string(),
  cursor: z.string(),
  emittedAtMs: z.number(),
  payload: z.record(z.string(), z.unknown()),
});

const eventsEnvelope = z.object({ subscriptionId: z.string(), cursor: z.string() });

/** A stand-in for `bureau.events`: a scoped subscription served from `TestHost`. */
export const eventsOperation = defineOperation<
  typeof eventsInput,
  typeof eventsEnvelope,
  typeof testEventSchema,
  TestHost
>({
  name: 'probe.events',
  kind: 'subscription',
  mcpExposable: false,
  summary: 'Follow the probe feed',
  destructive: false,
  tags: ['Events'],
  inputSchema: eventsInput,
  outputSchema: eventsEnvelope,
  eventSchema: testEventSchema,
  access: { kind: 'scoped', scopes: { kind: 'anyOf', scopes: ['events:read'] } },
  discoverable: true,
  transports: { http: true, jsonRpcHttp: false, jsonRpcWebSocket: true, jsonRpcStdio: false },
  unknownKeyPolicy: { http: 'reject', jsonRpc: 'reject' },
  invoke: async ({ input, host }) => {
    host.seenInputs.push(input);
    const controller = new AbortController();
    return {
      subscriptionId: 'sub_1',
      envelope: { subscriptionId: 'sub_1', cursor: input.fromCursor ?? '0' },
      iterable: host.feed.subscribe(input.fromCursor, controller.signal),
      close: async () => {
        host.closed.count += 1;
        controller.abort();
      },
    };
  },
});

/** A unary operation that needs `events:read`, to prove mounts run the real pipeline. */
export const scopedEchoOperation = defineOperation<
  z.ZodObject<{ message: z.ZodString }>,
  z.ZodObject<{ message: z.ZodString }>,
  TestHost
>({
  name: 'probe.scoped',
  mcpExposable: false,
  summary: 'Echo, behind a scope',
  destructive: false,
  inputSchema: z.object({ message: z.string() }),
  outputSchema: z.object({ message: z.string() }),
  access: { kind: 'scoped', scopes: { kind: 'anyOf', scopes: ['events:read'] } },
  discoverable: true,
  transports: { http: true, jsonRpcHttp: true, jsonRpcWebSocket: false, jsonRpcStdio: false },
  unknownKeyPolicy: { http: 'reject', jsonRpc: 'reject' },
  invoke: async ({ input }) => ({ message: input.message }),
});

/** The admission a host's `authenticate` returns for a caller holding `events:read`. */
export function readerContext(): AuthContext {
  return {
    method: 'api-key',
    principal: principalFromApiKey({ subject: 'reader', scopes: ['events:read'] }),
  };
}

/** The admission for a caller who authenticated but holds no scope. */
export function strangerContext(): AuthContext {
  return {
    method: 'api-key',
    principal: principalFromApiKey({ subject: 'stranger', scopes: [] }),
  };
}

export type ManualScheduler = {
  readonly schedule: ServerSentEventTimerScheduler;
  /** The delays asked for, in order. */
  readonly delays: number[];
  /** Fire every live timer scheduled for `delayMs`. */
  fire(delayMs: number): void;
  /** How many timers for `delayMs` were cancelled. */
  cancelled(delayMs: number): number;
};

export function createManualScheduler(): ManualScheduler {
  const timers: { callback: () => void; delayMs: number; cancelled: boolean }[] = [];
  return {
    schedule(callback, delayMs) {
      const timer = { callback, delayMs, cancelled: false };
      timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
    get delays() {
      return timers.map((timer) => timer.delayMs);
    },
    fire(delayMs) {
      for (const timer of timers.filter((entry) => entry.delayMs === delayMs && !entry.cancelled)) {
        timer.callback();
      }
    },
    cancelled(delayMs) {
      return timers.filter((timer) => timer.delayMs === delayMs && timer.cancelled).length;
    },
  };
}

/** Reads the HTTP status of a handler response. */
export async function statusOf(
  handler: (request: Request) => Promise<Response>,
  request: Request,
): Promise<number> {
  const response = await handler(request);
  return response.status;
}

/** Read SSE frames from a response body until `count` complete frames have arrived. */
export async function readFrames(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  count: number,
): Promise<string[]> {
  const decoder = new TextDecoder();
  const frames: string[] = [];
  let buffer = '';
  while (frames.length < count) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let boundary = buffer.indexOf('\n\n');
    while (boundary !== -1) {
      frames.push(buffer.slice(0, boundary));
      buffer = buffer.slice(boundary + 2);
      boundary = buffer.indexOf('\n\n');
    }
  }
  return frames;
}

export function eventStreamRequest(path: string, headers: Record<string, string> = {}): Request {
  return new Request(`http://localhost${path}`, {
    headers: { Accept: 'text/event-stream', ...headers },
  });
}

/** Builds a JSON-RPC POST request for the handler under test. */
export function jsonRpcRequest(
  method: string,
  params: unknown,
  headers: Record<string, string> = {},
): Request {
  return new Request('http://localhost/jsonrpc', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
}
