import { describe, expect, it } from 'bun:test';

import { Engine } from '../../core/engine.ts';
import type { WorkflowContext } from '../../core/types.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import {
  invalidJsonRequest,
  jsonRequest,
  waitForWorkflowStatus,
} from './operation-test-helpers.ts';

describe('operation test helpers', () => {
  it('builds JSON requests only when a body is provided', async () => {
    const requestWithBody = jsonRequest('POST', '/v1/workflows', { type: 'echo' });

    expect(requestWithBody.method).toBe('POST');
    expect(requestWithBody.url).toBe('http://localhost/v1/workflows');
    expect(requestWithBody.headers.get('Content-Type')).toBe('application/json');
    expect(await requestWithBody.json()).toEqual({ type: 'echo' });

    const requestWithoutBody = jsonRequest('GET', '/v1/workflows');
    expect(requestWithoutBody.method).toBe('GET');
    expect(requestWithoutBody.headers.get('Content-Type')).toBeNull();
    expect(await requestWithoutBody.text()).toBe('');
  });

  it('builds malformed JSON requests without serializing the raw body', async () => {
    const request = invalidJsonRequest('POST', '/v1/workflows', '{');

    expect(request.method).toBe('POST');
    expect(request.headers.get('Content-Type')).toBe('application/json');
    expect(await request.text()).toBe('{');
  });

  it('waits for a workflow to reach an expected status', async () => {
    const engine = new Engine({ storage: new MemoryStorage() });
    engine.register('echo', async function* (_ctx: WorkflowContext, input: unknown) {
      return input;
    });

    try {
      const handle = await engine.start('echo', { ok: true }, { id: 'helper-status-success' });

      await waitForWorkflowStatus(engine, handle.id, 'completed');

      const state = await engine.get(handle.id);
      expect(state?.status).toBe('completed');
    } finally {
      engine[Symbol.dispose]();
    }
  });

  it('reports the workflow id, expected status, and timeout when waiting fails', async () => {
    const engine = new Engine({ storage: new MemoryStorage() });

    try {
      await expect(
        waitForWorkflowStatus(engine, 'missing-workflow', 'running', {
          intervalMilliseconds: 1,
          timeoutMilliseconds: 1,
        }),
      ).rejects.toThrow('Workflow missing-workflow did not reach running within 1ms');
    } finally {
      engine[Symbol.dispose]();
    }
  });
});
