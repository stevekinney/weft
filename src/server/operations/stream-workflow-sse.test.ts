import { describe, expect, it } from 'bun:test';

import { Engine } from '../../core/engine.ts';
import type { WorkflowContext } from '../../core/types.ts';
import { workflow } from '../../core/types.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { handleRequest } from '../handler.ts';
import { createOperationRegistry } from '../operation-catalog.ts';
import { streamWorkflowSseOperation, streamWorkflowSseRestBinding } from './stream-workflow-sse.ts';

const holdWorkflow = workflow({ name: 'hold' }).execute(async function* (_ctx: WorkflowContext) {
  return null;
});

function createEngine(): Engine {
  const engine = new Engine({ storage: new MemoryStorage() });
  // A trivial workflow used only to anchor a real workflow id in storage.
  engine.register(holdWorkflow);
  return engine;
}

const registry = createOperationRegistry([streamWorkflowSseOperation]);
const bindings = [streamWorkflowSseRestBinding];

function request(method: string, path: string, headers?: Record<string, string>): Request {
  const init: RequestInit = { method };
  if (headers !== undefined) {
    init.headers = headers;
  }
  return new Request(`http://localhost${path}`, init);
}

describe('weft.workflows.streams.sse', () => {
  it('streams stored token chunks as SSE on the happy path', async () => {
    const engine = createEngine();
    const handle = await engine.start('hold', null, { id: 'wf-sse' });
    const original = engine.getStreamChunks.bind(engine);
    engine.getStreamChunks = async () => [
      { sequence: 1, value: 'alpha' },
      { sequence: 2, value: { token: 'beta' } },
      { sequence: 3, value: 99 }, // dropped — not a string and no token field
    ];

    try {
      const response = await handleRequest(
        request('GET', `/v1/workflows/${handle.id}/sse`, { Accept: 'text/event-stream' }),
        engine,
        { operationRegistry: registry, restBindings: bindings },
      );

      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe('text/event-stream');
      expect(response.headers.get('cache-control')).toBe('no-cache');
      expect(response.headers.get('connection')).toBe('keep-alive');
      const body = await response.text();
      expect(body).toContain('id: 1');
      expect(body).toContain('data: alpha');
      expect(body).toContain('id: 2');
      expect(body).toContain('data: beta');
      expect(body).not.toContain('id: 3');
      expect(body).toContain('event: done');
    } finally {
      engine.getStreamChunks = original;
    }
  });

  it('returns 406 when Accept header lacks text/event-stream', async () => {
    const engine = createEngine();
    const handle = await engine.start('hold', null, { id: 'wf-sse-406' });

    const response = await handleRequest(
      request('GET', `/v1/workflows/${handle.id}/sse`, { Accept: 'application/json' }),
      engine,
      { operationRegistry: registry, restBindings: bindings },
    );

    expect(response.status).toBe(406);
    expect(await response.json()).toEqual({
      error: 'Accept header must include text/event-stream',
    });
  });

  it('returns 404 when the workflow does not exist', async () => {
    const engine = createEngine();

    const response = await handleRequest(
      request('GET', '/v1/workflows/missing-wf/sse', { Accept: 'text/event-stream' }),
      engine,
      { operationRegistry: registry, restBindings: bindings },
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Workflow "missing-wf" not found' });
  });

  it('forwards a Last-Event-ID cursor to engine.getStreamChunks', async () => {
    const engine = createEngine();
    const handle = await engine.start('hold', null, { id: 'wf-sse-resume' });
    const original = engine.getStreamChunks.bind(engine);
    let capturedAfter: number | undefined;
    engine.getStreamChunks = async (_workflowId, _key, options) => {
      capturedAfter = options?.after;
      return [];
    };

    try {
      await handleRequest(
        request('GET', `/v1/workflows/${handle.id}/sse`, {
          Accept: 'text/event-stream',
          'Last-Event-ID': '5',
        }),
        engine,
        { operationRegistry: registry, restBindings: bindings },
      );
      expect(capturedAfter).toBe(5);
    } finally {
      engine.getStreamChunks = original;
    }
  });

  it('returns 404 (not 400) for missing-workflow + invalid Last-Event-ID', async () => {
    // Precedence: workflow existence is checked BEFORE
    // parsing `Last-Event-ID`, so a missing workflow with a bad cursor
    // returned 404, not 400. Pin this so a future refactor that re-orders
    // those checks (e.g. parsing the cursor in extractInput) breaks loudly.
    const engine = createEngine();

    const response = await handleRequest(
      request('GET', '/v1/workflows/missing-wf/sse', {
        Accept: 'text/event-stream',
        'Last-Event-ID': 'not-a-number',
      }),
      engine,
      { operationRegistry: registry, restBindings: bindings },
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Workflow "missing-wf" not found' });
  });

  it('returns 400 for an invalid Last-Event-ID header', async () => {
    const engine = createEngine();
    const handle = await engine.start('hold', null, { id: 'wf-sse-bad-cursor' });

    const response = await handleRequest(
      request('GET', `/v1/workflows/${handle.id}/sse`, {
        Accept: 'text/event-stream',
        'Last-Event-ID': 'not-a-number',
      }),
      engine,
      { operationRegistry: registry, restBindings: bindings },
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'Invalid Last-Event-ID header: not-a-number',
    });
  });

  it('sanitizes engine errors to 500 "Internal server error"', async () => {
    // Engine errors are masked before returning to the client. Pin that —
    // raw engine messages can contain SQL fragments, file paths, etc., and
    // must never reach a caller.
    const engine = createEngine();
    const handle = await engine.start('hold', null, { id: 'wf-sse-fail' });
    const original = engine.getStreamChunks.bind(engine);
    engine.getStreamChunks = async () => {
      throw new Error('storage offline: secret-credential-leak');
    };

    try {
      const response = await handleRequest(
        request('GET', `/v1/workflows/${handle.id}/sse`, { Accept: 'text/event-stream' }),
        engine,
        { operationRegistry: registry, restBindings: bindings },
      );
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: 'Internal server error' });
    } finally {
      engine.getStreamChunks = original;
    }
  });
});
