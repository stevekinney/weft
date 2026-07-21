import { afterEach, describe, expect, it } from 'bun:test';

import { Engine } from '../core/engine.ts';
import { StartWorkflowValidationError } from '../core/start-workflow-validation.ts';
import type { WorkflowContext } from '../core/types.ts';
import { workflow } from '../core/types.ts';
import { MemoryStorage } from '../storage/memory.ts';
import { handleRequest, type HandlerOptions } from './handler.ts';
import { principalFromApiKey } from './principal.ts';

const echoWorkflow = workflow({ name: 'echo' }).execute(async function* (
  _ctx: WorkflowContext,
  input: unknown,
) {
  return input;
});

function apiKeyAuth(): HandlerOptions {
  return {
    authContext: {
      method: 'api-key' as const,
      principal: principalFromApiKey({
        subject: 'test',
        scopes: ['workflows:read', 'workflows:admin'],
      }),
    },
  };
}

function createEngine(): Engine {
  const engine = new Engine({
    storage: new MemoryStorage(),
  });

  engine.register(echoWorkflow);

  return engine;
}

function request(method: string, path: string, body?: unknown): Request {
  const init: RequestInit = {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  };
  if (body !== undefined) {
    init.headers = { 'Content-Type': 'application/json' };
  }

  return new Request(`http://localhost${path}`, init);
}

async function json(response: Response): Promise<unknown> {
  return response.json();
}

describe('handleRequest edge coverage', () => {
  let engine: Engine | undefined;

  afterEach(() => {
    engine?.[Symbol.dispose]();
    engine = undefined;
  });

  it('returns 400 when a route parameter cannot be decoded', async () => {
    engine = createEngine();

    const response = await handleRequest(request('GET', '/v1/workflows/%E0%A4%A'), engine);

    expect(response.status).toBe(400);
    expect(await json(response)).toEqual({ error: 'Malformed route parameter encoding' });
  });

  it('accepts purge body filters with array statuses, numeric bounds, and attribute arrays', async () => {
    engine = createEngine();
    let capturedFilter: unknown;
    engine.purge = async (filter) => {
      capturedFilter = filter;
      return { deleted: 0 };
    };

    const response = await handleRequest(
      request('POST', '/v1/workflows/purge', {
        filter: {
          status: ['running', 'failed'],
          type: 'echo',
          tags: ['alpha', 'beta'],
          limit: 2.9,
          offset: 1.2,
          attributes: [
            { key: 'priority', value: ['high', 'urgent'] },
            { key: 'attempt', gte: 1 },
          ],
        },
      }),
      engine,
    );

    expect(response.status).toBe(200);
    expect(capturedFilter).toEqual({
      status: ['running', 'failed'],
      type: 'echo',
      tags: ['alpha', 'beta'],
      limit: 2,
      offset: 1,
      attributes: [
        { key: 'priority', value: ['high', 'urgent'] },
        { key: 'attempt', gte: 1 },
      ],
    });
  });

  it('rejects invalid purge filters and malformed list tag query parameters', async () => {
    engine = createEngine();

    const invalidBodies = [
      [{ filter: 'bad' }, 'Field "filter" must be an object'],
      [
        { filter: { status: 123 } },
        'Field "filter.status" must be a string or an array of strings',
      ],
      [{ filter: { type: 123 } }, 'Field "filter.type" must be a string'],
      [{ filter: { limit: 'a lot' } }, 'Field "filter.limit" must be a non-negative number'],
      [{ filter: { attributes: 'bad' } }, 'Field "filter.attributes" must be an array'],
      [{ filter: { attributes: [null] } }, 'Field "filter.attributes[0]" must be an object'],
      [
        { filter: { attributes: [{ key: '' }] } },
        'Field "filter.attributes[0].key" must be a non-empty string',
      ],
      [
        { filter: { attributes: [{ key: 'priority', value: { nested: true } }] } },
        'Field "filter.attributes[0].value" must be a string, number, boolean, or scalar array',
      ],
    ] as const;

    for (const [body, message] of invalidBodies) {
      const response = await handleRequest(request('POST', '/v1/workflows/purge', body), engine);
      expect(response.status).toBe(400);
      expect(await json(response)).toEqual({ error: message });
    }

    // Tag validation moved from `extractInput` (REST-only) into the
    // operation's `invoke` so every transport runs the same check.
    // The error message now references the operation field name
    // (`tags`) instead of the REST query-parameter name.
    const malformedTagResponse = await handleRequest(request('GET', '/v1/workflows?tag='), engine);
    expect(malformedTagResponse.status).toBe(400);
    const malformedBody = (await json(malformedTagResponse)) as { error: string };
    expect(malformedBody.error).toContain('empty tags');
  });

  it('returns parse errors from every bulk workflow route before dispatching', async () => {
    engine = createEngine();
    let dispatchCount = 0;
    engine.cancelAll = async () => {
      dispatchCount++;
      throw new Error('cancel should not dispatch');
    };
    engine.signalAll = async () => {
      dispatchCount++;
      throw new Error('signal should not dispatch');
    };
    engine.retryFailedAll = async () => {
      dispatchCount++;
      throw new Error('retry failed should not dispatch');
    };
    engine.deleteAll = async () => {
      dispatchCount++;
      throw new Error('delete should not dispatch');
    };
    engine.tagAll = async () => {
      dispatchCount++;
      throw new Error('tag should not dispatch');
    };

    const routes = [
      ['POST', '/v1/workflows/bulk/cancel'],
      ['POST', '/v1/workflows/bulk/signal'],
      ['POST', '/v1/workflows/bulk/retry-failed'],
      ['DELETE', '/v1/workflows/bulk'],
      ['PATCH', '/v1/workflows/bulk/tags'],
    ] as const;

    for (const [method, path] of routes) {
      const response = await handleRequest(
        new Request(`http://localhost${path}`, {
          method,
          headers: { 'Content-Type': 'application/json' },
          body: '{"filter":',
        }),
        engine,
      );

      expect(response.status).toBe(400);
      expect(await json(response)).toEqual({ error: 'Invalid JSON body' });
    }
    expect(dispatchCount).toBe(0);
  });

  it('validates bulk signal and tag mutation bodies before dispatching', async () => {
    engine = createEngine();
    let dispatchCount = 0;
    engine.signalAll = async () => {
      dispatchCount++;
      throw new Error('signal should not dispatch');
    };
    engine.deleteAll = async () => {
      dispatchCount++;
      throw new Error('delete should not dispatch');
    };
    engine.tagAll = async () => {
      dispatchCount++;
      throw new Error('tag should not dispatch');
    };

    let response = await handleRequest(
      request('POST', '/v1/workflows/bulk/signal', ['not-an-object']),
      engine,
      apiKeyAuth(),
    );
    expect(response.status).toBe(400);
    expect(await json(response)).toEqual({ error: 'Request body must be a JSON object' });

    response = await handleRequest(
      request('POST', '/v1/workflows/bulk/signal', { filter: {}, name: 'continue' }),
      engine,
      apiKeyAuth(),
    );
    expect(response.status).toBe(400);
    expect(await json(response)).toEqual({
      error:
        'Field "filter" must include at least one of status, type, scheduleId, tags, attributes, idPrefix (≥3 chars), or failureCategory paired with status',
    });

    response = await handleRequest(
      request('POST', '/v1/workflows/bulk/signal', {
        filter: { tags: ['selected'] },
        name: '',
      }),
      engine,
      apiKeyAuth(),
    );
    expect(response.status).toBe(400);
    expect(await json(response)).toEqual({ error: 'Field "name" must be a non-empty string' });

    response = await handleRequest(
      request('DELETE', '/v1/workflows/bulk', { filter: {} }),
      engine,
      apiKeyAuth(),
    );
    expect(response.status).toBe(400);
    expect(await json(response)).toEqual({
      error:
        'Field "filter" must include at least one of status, type, scheduleId, tags, attributes, idPrefix (≥3 chars), or failureCategory paired with status',
    });

    response = await handleRequest(
      request('PATCH', '/v1/workflows/bulk/tags', ['not-an-object']),
      engine,
      apiKeyAuth(),
    );
    expect(response.status).toBe(400);
    expect(await json(response)).toEqual({ error: 'Request body must be a JSON object' });

    response = await handleRequest(
      request('PATCH', '/v1/workflows/bulk/tags', {
        filter: {},
        tags: ['bulk'],
        operation: 'add',
      }),
      engine,
      apiKeyAuth(),
    );
    expect(response.status).toBe(400);
    expect(await json(response)).toEqual({
      error:
        'Field "filter" must include at least one of status, type, scheduleId, tags, attributes, idPrefix (≥3 chars), or failureCategory paired with status',
    });

    response = await handleRequest(
      request('PATCH', '/v1/workflows/bulk/tags', {
        filter: { tags: ['selected'] },
        tags: [42],
        operation: 'add',
      }),
      engine,
      apiKeyAuth(),
    );
    expect(response.status).toBe(400);
    expect(await json(response)).toEqual({
      error: 'Field "tags" must contain only strings',
    });
    expect(dispatchCount).toBe(0);
  });

  it('maps bulk workflow engine failures to 500 responses', async () => {
    engine = createEngine();

    engine.cancelAll = async () => {
      throw new Error('cancel failed');
    };
    let response = await handleRequest(
      request('POST', '/v1/workflows/bulk/cancel', {
        filter: { tags: ['selected'] },
        confirmationToken: 'bulk:confirmed',
      }),
      engine,
      apiKeyAuth(),
    );
    expect(response.status).toBe(500);
    expect(typeof ((await json(response)) as { error?: unknown }).error).toBe('string');

    engine.signalAll = async () => {
      throw new Error('signal failed');
    };
    response = await handleRequest(
      request('POST', '/v1/workflows/bulk/signal', {
        filter: { tags: ['selected'] },
        name: 'continue',
        confirmationToken: 'bulk:confirmed',
      }),
      engine,
      apiKeyAuth(),
    );
    expect(response.status).toBe(500);
    expect(typeof ((await json(response)) as { error?: unknown }).error).toBe('string');

    engine.retryFailedAll = async () => {
      throw new Error('retry failed failed');
    };
    response = await handleRequest(
      request('POST', '/v1/workflows/bulk/retry-failed', {
        filter: { tags: ['selected'] },
        confirmationToken: 'bulk:confirmed',
      }),
      engine,
      apiKeyAuth(),
    );
    expect(response.status).toBe(500);
    expect(typeof ((await json(response)) as { error?: unknown }).error).toBe('string');

    engine.deleteAll = async () => {
      throw new Error('delete failed');
    };
    response = await handleRequest(
      request('DELETE', '/v1/workflows/bulk', {
        filter: { tags: ['selected'] },
        confirmationToken: 'bulk:confirmed',
      }),
      engine,
      apiKeyAuth(),
    );
    expect(response.status).toBe(500);
    expect(typeof ((await json(response)) as { error?: unknown }).error).toBe('string');

    engine.tagAll = async () => {
      throw new Error('tag failed');
    };
    response = await handleRequest(
      request('PATCH', '/v1/workflows/bulk/tags', {
        filter: { tags: ['selected'] },
        tags: ['bulk'],
        operation: 'add',
        confirmationToken: 'bulk:confirmed',
      }),
      engine,
      apiKeyAuth(),
    );
    expect(response.status).toBe(500);
    expect(typeof ((await json(response)) as { error?: unknown }).error).toBe('string');
  });

  it('maps addTags and removeTags failures to 404, 400, and 500 responses', async () => {
    engine = createEngine();

    engine.addTags = async () => {
      throw new Error('workflow not found');
    };
    let response = await handleRequest(
      request('POST', '/v1/workflows/wf-1/tags', { tags: ['alpha'] }),
      engine,
    );
    expect(response.status).toBe(404);

    engine.addTags = async () => {
      throw new StartWorkflowValidationError('Invalid tags');
    };
    response = await handleRequest(
      request('POST', '/v1/workflows/wf-1/tags', { tags: ['alpha'] }),
      engine,
    );
    expect(response.status).toBe(400);

    engine.addTags = async () => {
      throw new Error('boom');
    };
    response = await handleRequest(
      request('POST', '/v1/workflows/wf-1/tags', { tags: ['alpha'] }),
      engine,
    );
    expect(response.status).toBe(500);

    engine.removeTags = async () => {
      throw new Error('workflow not found');
    };
    response = await handleRequest(
      request('DELETE', '/v1/workflows/wf-1/tags', { tags: ['alpha'] }),
      engine,
    );
    expect(response.status).toBe(404);

    engine.removeTags = async () => {
      throw new StartWorkflowValidationError('Invalid tags');
    };
    response = await handleRequest(
      request('DELETE', '/v1/workflows/wf-1/tags', { tags: ['alpha'] }),
      engine,
    );
    expect(response.status).toBe(400);

    engine.removeTags = async () => {
      throw new Error('boom');
    };
    response = await handleRequest(
      request('DELETE', '/v1/workflows/wf-1/tags', { tags: ['alpha'] }),
      engine,
    );
    expect(response.status).toBe(500);
  });

  it('surfaces fork failures distinctly', async () => {
    engine = createEngine();

    engine.fork = async () => {
      throw new Error('workflow not found');
    };
    let response = await handleRequest(request('POST', '/v1/workflows/wf-1/fork'), engine);
    expect(response.status).toBe(404);

    engine.fork = async () => {
      throw new Error('fork exploded');
    };
    response = await handleRequest(request('POST', '/v1/workflows/wf-1/fork'), engine);
    expect(response.status).toBe(500);
  });

  it('covers schedule validation errors across schedule routes', async () => {
    engine = createEngine();

    let response = await handleRequest(
      request('POST', '/v1/schedules', {
        type: 'echo',
        input: null,
        id: '',
        cronExpression: '* * * * *',
      }),
      engine,
    );
    expect(response.status).toBe(400);
    expect(await json(response)).toEqual({ error: 'Field "id" must be a non-empty string' });

    response = await handleRequest(
      request('POST', '/v1/schedules', {
        type: 'echo',
        input: null,
        cronExpression: '* * * * *',
        overlap: 'parallel',
      }),
      engine,
    );
    expect(response.status).toBe(400);
    expect(await json(response)).toEqual({
      error: 'Field "overlap" must be one of skip, queue, cancel-running, allow',
    });

    response = await handleRequest(
      request('POST', '/v1/schedules', {
        type: 'echo',
        input: null,
        cronExpression: '* * * * *',
        backfill: 'yes',
      }),
      engine,
    );
    expect(response.status).toBe(400);
    expect(await json(response)).toEqual({ error: 'Field "backfill" must be a boolean' });

    response = await handleRequest(
      request('POST', '/v1/schedules', {
        type: 'echo',
        input: null,
      }),
      engine,
    );
    expect(response.status).toBe(400);
    expect(await json(response)).toEqual({
      error: 'Missing required field: cronExpression or every',
    });

    response = await handleRequest(
      new Request('http://localhost/v1/schedules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{bad json',
      }),
      engine,
    );
    expect(response.status).toBe(400);
    expect(await json(response)).toEqual({ error: 'Invalid JSON body' });

    response = await handleRequest(
      new Request('http://localhost/v1/schedules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '123',
      }),
      engine,
    );
    expect(response.status).toBe(400);
    expect(await json(response)).toEqual({ error: 'Request body must be a JSON object' });

    response = await handleRequest(
      request(
        'GET',
        '/v1/schedules?status=active&status=paused&workflowType=echo&limit=5001&offset=4',
      ),
      engine,
      apiKeyAuth(),
    );
    expect(response.status).toBe(200);
    expect(await json(response)).toEqual({
      items: [],
      total: 0,
      offset: 4,
      limit: 1000,
    });

    response = await handleRequest(
      request('GET', '/v1/schedules?status=active'),
      engine,
      apiKeyAuth(),
    );
    expect(response.status).toBe(200);
    expect(await json(response)).toEqual({
      items: [],
      total: 0,
      offset: 0,
      limit: 0,
    });

    response = await handleRequest(
      new Request('http://localhost/v1/schedules/schedule-1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: '{bad json',
      }),
      engine,
    );
    expect(response.status).toBe(400);
    expect(await json(response)).toEqual({ error: 'Invalid JSON body' });

    response = await handleRequest(
      new Request('http://localhost/v1/schedules/schedule-1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: '123',
      }),
      engine,
    );
    expect(response.status).toBe(400);
    expect(await json(response)).toEqual({ error: 'Request body must be a JSON object' });

    response = await handleRequest(request('PATCH', '/v1/schedules/schedule-1', {}), engine);
    expect(response.status).toBe(400);
    expect(await json(response)).toEqual({
      error: 'Missing required field: cronExpression or every',
    });
  });

  it('maps schedule handler engine failures to their HTTP responses', async () => {
    engine = createEngine();

    engine.schedule = async () => {
      throw new Error('schedule already exists');
    };
    let response = await handleRequest(
      request('POST', '/v1/schedules', {
        type: 'echo',
        input: null,
        cronExpression: '* * * * *',
      }),
      engine,
    );
    expect(response.status).toBe(409);

    engine.schedule = async () => {
      throw new Error('exploded');
    };
    response = await handleRequest(
      request('POST', '/v1/schedules', {
        type: 'echo',
        input: null,
        cronExpression: '* * * * *',
      }),
      engine,
    );
    expect(response.status).toBe(500);

    engine.getSchedule = async () => {
      throw new Error('lookup exploded');
    };
    response = await handleRequest(
      request('GET', '/v1/schedules/schedule-1'),
      engine,
      apiKeyAuth(),
    );
    expect(response.status).toBe(500);

    engine.resumeSchedule = async () => {
      throw new Error('Schedule cannot be resumed after cancellation');
    };
    response = await handleRequest(request('POST', '/v1/schedules/schedule-1/resume'), engine);
    expect(response.status).toBe(409);
  });
});
