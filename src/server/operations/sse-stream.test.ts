import { describe, expect, it } from 'bun:test';

import type { OperationFault } from '../operation-fault.ts';
import {
  acceptsServerSentEvents,
  createEventEnvelopeSSEStream,
  formatServerSentEvent,
  type ServerSentEventTimerScheduler,
} from './sse-stream.ts';

function decode(bytes: Uint8Array | undefined): string {
  if (bytes === undefined) return '';
  return new TextDecoder().decode(bytes);
}

function manualScheduler(): {
  readonly scheduler: ServerSentEventTimerScheduler;
  tick(): void;
  readonly cleared: boolean;
} {
  let callback: (() => void) | null = null;
  let cleared = false;
  return {
    scheduler(nextCallback) {
      callback = nextCallback;
      return () => {
        cleared = true;
      };
    },
    tick() {
      if (callback === null) throw new Error('heartbeat callback was not scheduled');
      callback();
    },
    get cleared() {
      return cleared;
    },
  };
}

async function* neverEnding(): AsyncIterable<never> {
  await new Promise<never>(() => undefined);
}

describe('Server-Sent Event helpers', () => {
  it('parses SSE Accept media ranges exactly and case-insensitively', () => {
    expect(acceptsServerSentEvents('Text/Event-Stream; charset=utf-8')).toBe(true);
    expect(acceptsServerSentEvents('application/json, text/*;q=0.8')).toBe(true);
    expect(acceptsServerSentEvents('*/*')).toBe(true);
    expect(acceptsServerSentEvents('text/event-streamx')).toBe(false);
    expect(acceptsServerSentEvents('application/json')).toBe(false);
  });

  it('formats event, id, and multiline data fields', () => {
    expect(
      formatServerSentEvent({
        id: '7',
        event: 'workflow:started',
        data: 'first\nsecond',
      }),
    ).toBe('id: 7\nevent: workflow:started\ndata: first\ndata: second\n\n');
  });

  it('serializes event envelopes as cursor-keyed SSE frames', async () => {
    const stream = createEventEnvelopeSSEStream({
      iterable: (async function* () {
        yield {
          kind: 'workflow:started',
          workflowId: 'wf-sse',
          selector: 'events',
          sequence: 3,
          cursor: '3',
          emittedAtMs: 123,
          payload: { workflowId: 'wf-sse' },
        };
      })(),
      close: async () => undefined,
    });

    const body = await new Response(stream).text();

    expect(body).toContain('id: 3');
    expect(body).toContain('event: workflow:started');
    expect(body).toContain('"workflowId":"wf-sse"');
    expect(body).toContain('"cursor":"3"');
  });

  it('emits ping events without advancing the cursor and clears timers on cancel', async () => {
    const heartbeat = manualScheduler();
    let closed = false;
    const stream = createEventEnvelopeSSEStream({
      iterable: neverEnding(),
      close: async () => {
        closed = true;
      },
      heartbeat: {
        intervalMs: 1_000,
        schedule: heartbeat.scheduler,
        now: () => 42,
      },
    });

    const reader = stream.getReader();
    heartbeat.tick();
    const ping = await reader.read();
    await reader.cancel();

    expect(decode(ping.value)).toBe('event: ping\ndata: {"emittedAtMs":42}\n\n');
    expect(decode(ping.value)).not.toContain('id:');
    expect(closed).toBe(true);
    expect(heartbeat.cleared).toBe(true);
  });

  it('emits a replay-complete ping without advancing the cursor', async () => {
    const ready = Promise.withResolvers<void>();
    const stream = createEventEnvelopeSSEStream({
      iterable: neverEnding(),
      close: async () => undefined,
      ready: ready.promise,
      heartbeat: { intervalMs: 0, now: () => 42 },
    });
    const reader = stream.getReader();

    ready.resolve();
    const ping = await reader.read();
    await reader.cancel();

    expect(decode(ping.value)).toBe(
      'event: ping\ndata: {"emittedAtMs":42,"replayComplete":true}\n\n',
    );
    expect(decode(ping.value)).not.toContain('id:');
  });

  it('ignores replay-complete readiness rejections', async () => {
    const ready = Promise.withResolvers<void>();
    let closed = false;
    const stream = createEventEnvelopeSSEStream({
      iterable: (async function* finishAfterTick() {
        await Promise.resolve();
      })(),
      close: async () => {
        closed = true;
      },
      ready: ready.promise,
      heartbeat: { intervalMs: 0 },
    });
    const reader = stream.getReader();

    ready.reject(new Error('replay cancelled'));
    await Promise.resolve();
    await Promise.resolve();
    const result = await reader.read();

    expect(result.done).toBe(true);
    expect(closed).toBe(true);
  });

  it('closes immediately when the request signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const closed = Promise.withResolvers<void>();
    const stream = createEventEnvelopeSSEStream({
      iterable: neverEnding(),
      close: async () => {
        closed.resolve();
      },
      signal: controller.signal,
    });

    await expect(new Response(stream).text()).resolves.toBe('');
    await closed.promise;
  });

  it('runs cleanup when the request signal aborts after stream start', async () => {
    const controller = new AbortController();
    const closed = Promise.withResolvers<void>();
    const stream = createEventEnvelopeSSEStream({
      iterable: neverEnding(),
      close: async () => {
        closed.resolve();
      },
      signal: controller.signal,
    });

    const response = new Response(stream);
    controller.abort();

    await closed.promise;
    await response.body?.cancel().catch(() => undefined);
  });

  it('runs cleanup when enqueue fails after stream start', async () => {
    const originalReadableStream = globalThis.ReadableStream;
    const closed = Promise.withResolvers<void>();
    function ThrowingReadableStream(source: UnderlyingSource<Uint8Array>): void {
      void source.start?.({
        enqueue() {
          throw new Error('enqueue failed');
        },
        close() {},
      } as unknown as ReadableStreamDefaultController<Uint8Array>);
    }

    try {
      globalThis.ReadableStream = ThrowingReadableStream as unknown as typeof ReadableStream;
      createEventEnvelopeSSEStream({
        iterable: (async function* () {
          yield { kind: 'workflow:started', cursor: '0', emittedAtMs: 0 };
        })(),
        close: async () => {
          closed.resolve();
        },
      });

      await closed.promise;
    } finally {
      globalThis.ReadableStream = originalReadableStream;
    }
  });

  it('emits sanitized error frames for post-start stream failures', async () => {
    const fault: OperationFault = {
      code: 'InvalidParams',
      message: 'Workflow event replay window is too large',
      data: { issues: [] },
    };
    const stream = createEventEnvelopeSSEStream({
      iterable: (async function* () {
        throw fault;
      })(),
      close: async () => undefined,
    });

    const body = await new Response(stream).text();

    expect(body).toContain('event: error');
    expect(body).toContain('"code":"InvalidParams"');
    expect(body).toContain('"message":"Workflow event replay window is too large"');
  });

  it('masks unexpected stream failures in error frames', async () => {
    const stream = createEventEnvelopeSSEStream({
      iterable: (async function* () {
        throw new Error('storage secret leaked');
      })(),
      close: async () => undefined,
    });

    const body = await new Response(stream).text();

    expect(body).toContain('event: error');
    expect(body).toContain('"code":"EngineFailure"');
    expect(body).toContain('"message":"Internal server error"');
    expect(body).not.toContain('storage secret leaked');
  });
});
