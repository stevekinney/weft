import { afterEach, describe, expect, it } from 'bun:test';

import { Engine } from '../../core/engine.ts';
import type { WorkflowContext, WorkflowState, WorkflowStatus } from '../../core/types.ts';
import { workflow } from '../../core/types.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { restoreRealTimers, useFakeTimers } from '../../testing/fake-timers.test-support.ts';
import {
  invalidJsonRequest,
  jsonRequest,
  waitForWorkflowStatus,
} from './operation-test-helpers.test-support.ts';

const echoWorkflow = workflow({ name: 'echo' }).execute(async function* (
  _ctx: WorkflowContext,
  input: unknown,
) {
  return input;
});

function workflowState(status: WorkflowStatus, workflowId = 'helper-status'): WorkflowState {
  return {
    createdAt: Date.now(),
    id: workflowId,
    input: null,
    status,
    type: 'helper',
    updatedAt: Date.now(),
    versionTuple: { workflowVersion: 'test-version' },
  };
}

describe('operation test helpers', () => {
  afterEach(() => {
    restoreRealTimers();
  });

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
    engine.register(echoWorkflow);

    try {
      const handle = await engine.start('echo', { ok: true }, { id: 'helper-status-success' });

      await waitForWorkflowStatus(engine, handle.id, 'completed');

      const state = await engine.get(handle.id);
      expect(state?.status).toBe('completed');
    } finally {
      engine[Symbol.dispose]();
    }
  });

  it('polls again at the timeout boundary before failing', async () => {
    useFakeTimers(new Date('2026-01-01T00:00:00.000Z'));

    const engine = new Engine({ storage: new MemoryStorage() });
    let reads = 0;
    engine.get = async (workflowId: string): Promise<WorkflowState | null> => {
      reads += 1;
      return workflowState(reads === 1 ? 'pending' : 'running', workflowId);
    };

    try {
      await waitForWorkflowStatus(engine, 'boundary-workflow', 'running', {
        intervalMilliseconds: 5,
        timeoutMilliseconds: 5,
      });

      expect(reads).toBe(2);
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
      ).rejects.toThrow(
        'Timed out after 1ms waiting for workflow missing-workflow to reach running',
      );
    } finally {
      engine[Symbol.dispose]();
    }
  });

  it('rejects non-positive polling intervals', async () => {
    const engine = new Engine({ storage: new MemoryStorage() });

    try {
      await expect(
        waitForWorkflowStatus(engine, 'invalid-interval-workflow', 'running', {
          intervalMilliseconds: 0,
          timeoutMilliseconds: 1,
        }),
      ).rejects.toThrow('intervalMs must be a finite, positive number');
    } finally {
      engine[Symbol.dispose]();
    }
  });
});
