import { describe, expect, it } from 'bun:test';

import { Engine } from '../core/engine.ts';
import type { WorkflowContext } from '../core/types.ts';
import { workflow } from '../core/types.ts';
import { serve } from '../server/index.ts';
import { executeTail, streamWorkflowEvents } from './tail.ts';

const encoder = new TextEncoder();

function sseResponse(frames: string[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(frame));
      controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

const holdWorkflow = workflow({ name: 'hold' }).execute(async function* (_ctx: WorkflowContext) {
  return null;
});

describe('streamWorkflowEvents', () => {
  it('emits one valid NDJSON object per SSE frame under --json', async () => {
    const lines: string[] = [];
    const exitCode = await streamWorkflowEvents({
      url: new URL('http://localhost/v1/workflows/wf/sse'),
      signal: new AbortController().signal,
      write: (line) => lines.push(line),
      json: true,
      fetchImpl: async () =>
        sseResponse([
          'id: 1\nevent: token\ndata: alpha\n\n',
          'id: 2\nevent: token\ndata: beta\n\n',
          'event: done\ndata: \n\n',
        ]),
    });

    expect(exitCode).toBe(0);
    expect(lines).toHaveLength(2);
    for (const line of lines) expect(() => JSON.parse(line)).not.toThrow();
    expect(JSON.parse(lines[0]!)).toEqual({ id: '1', event: 'token', data: 'alpha' });
    expect(JSON.parse(lines[1]!)).toEqual({ id: '2', event: 'token', data: 'beta' });
  });

  it('stops at the done event without emitting it', async () => {
    const lines: string[] = [];
    await streamWorkflowEvents({
      url: new URL('http://localhost/v1/workflows/wf/sse'),
      signal: new AbortController().signal,
      write: (line) => lines.push(line),
      json: false,
      fetchImpl: async () =>
        sseResponse([
          'event: token\ndata: only\n\n',
          'event: done\ndata: \n\n',
          'event: token\ndata: never\n\n',
        ]),
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('only');
  });

  it('exits 0 cleanly when the signal aborts mid-stream', async () => {
    const controller = new AbortController();
    const lines: string[] = [];
    const body = new ReadableStream<Uint8Array>({
      start(controller2) {
        controller2.enqueue(encoder.encode('event: token\ndata: first\n\n'));
        // Never closes; the abort must end the read.
      },
    });

    const promise = streamWorkflowEvents({
      url: new URL('http://localhost/v1/workflows/wf/sse'),
      signal: controller.signal,
      write: (line) => {
        lines.push(line);
        controller.abort();
      },
      json: true,
      fetchImpl: async () =>
        new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    });

    const exitCode = await promise;
    expect(exitCode).toBe(0);
    expect(lines).toHaveLength(1);
  });

  it('returns exit 2 on a connection failure', async () => {
    const lines: string[] = [];
    const exitCode = await streamWorkflowEvents({
      url: new URL('http://localhost/v1/workflows/wf/sse'),
      signal: new AbortController().signal,
      write: (line) => lines.push(line),
      json: true,
      fetchImpl: async () => {
        throw new Error('refused');
      },
    });
    expect(exitCode).toBe(2);
    expect(lines[0]).toContain('connection failed');
  });

  it('returns exit 1 on a 404', async () => {
    const exitCode = await streamWorkflowEvents({
      url: new URL('http://localhost/v1/workflows/missing/sse'),
      signal: new AbortController().signal,
      write: () => undefined,
      json: true,
      fetchImpl: async () => new Response('nope', { status: 404 }),
    });
    expect(exitCode).toBe(1);
  });

  it('routes errors to reportError, not the event sink', async () => {
    const events: string[] = [];
    const errors: string[] = [];
    const exitCode = await streamWorkflowEvents({
      url: new URL('http://localhost/v1/workflows/wf/sse'),
      signal: new AbortController().signal,
      write: (line) => events.push(line),
      reportError: (line) => errors.push(line),
      json: true,
      fetchImpl: async () => {
        throw new Error('refused');
      },
    });
    expect(exitCode).toBe(2);
    expect(events).toHaveLength(0);
    expect(errors[0]).toContain('connection failed');
  });
});

describe('weft tail', () => {
  it('requires a workflow id (system-wide tail not yet available)', async () => {
    const result = await executeTail({
      command: 'tail',
      help: false,
      json: false,
      quiet: false,
    });
    expect(result.exitCode).toBe(3);
    expect(result.stderr).toContain('workflow id is required');
  });

  it('streams a live workflow SSE endpoint and exits 0', async () => {
    const engine = new Engine();
    engine.register(holdWorkflow);
    const server = serve({ engine, port: 0 });
    try {
      const handle = await engine.start('hold', null, { id: 'wf-tail-live' });
      const result = await executeTail({
        command: 'tail',
        server: server.url.toString(),
        workflowId: handle.id,
        help: false,
        json: true,
        quiet: true,
      });
      expect(result.exitCode).toBe(0);
    } finally {
      await server.stop();
      engine[Symbol.dispose]();
    }
  });
});
