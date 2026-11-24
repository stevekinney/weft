import { describe, expect, it } from 'bun:test';

import { createOperationRegistry } from "../../embedded/backchannel/src/internals.ts";
import { MemoryStorage } from "../../embedded/storage/src/index.ts";
import { AggregateDistinctKeyCapExceededError } from '../../core/aggregate-validation.ts';
import { Engine } from '../../core/engine.ts';
import { workflow } from '../../core/types.ts';
import { handleRequestAsLocalUser as handleRequest } from '../local-user-request.test-support.ts';
import {
  aggregateWorkflowsOperation,
  aggregateWorkflowsRestBinding,
} from './aggregate-workflows.ts';

const registry = createOperationRegistry([aggregateWorkflowsOperation]);
const bindings = [aggregateWorkflowsRestBinding];

describe('weft.workflows.aggregate', () => {
  it('rejects an unknown REST grouping parameter', async () => {
    const engine = new Engine({ storage: new MemoryStorage() });

    const response = await handleRequest(
      new Request('http://localhost/v1/workflows/aggregate?group_by=unknown', { method: 'GET' }),
      engine,
      { operationRegistry: registry, restBindings: bindings },
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'group_by must be one of "status", "type", "failureCategory", or "attribute:<name>"',
      retryable: false,
    });
    engine[Symbol.dispose]();
  });

  it('passes the REST schedule filter to engine.aggregate', async () => {
    const engine = new Engine({ storage: new MemoryStorage() });
    engine.aggregate = async (filter, options) => {
      expect(filter).toMatchObject({ scheduleId: 'nightly-orders' });
      expect(options.groupBy).toBe('status');
      return { total: 0, groups: [], truncated: false };
    };

    const response = await handleRequest(
      new Request(
        'http://localhost/v1/workflows/aggregate?group_by=status&schedule_id=nightly-orders',
        { method: 'GET' },
      ),
      engine,
      { operationRegistry: registry, restBindings: bindings },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ total: 0, groups: [], truncated: false });
    engine[Symbol.dispose]();
  });

  it('forwards a valid REST limit to engine.aggregate and drops one that is not a positive number', async () => {
    const engine = new Engine({ storage: new MemoryStorage() });
    const seenLimits: Array<number | undefined> = [];
    engine.aggregate = async (_filter, options) => {
      seenLimits.push(options.limit);
      return { total: 0, groups: [], truncated: false };
    };

    for (const limit of ['7', '7.9', '0', '-3', 'abc']) {
      const response = await handleRequest(
        new Request(`http://localhost/v1/workflows/aggregate?group_by=status&limit=${limit}`, {
          method: 'GET',
        }),
        engine,
        { operationRegistry: registry, restBindings: bindings },
      );
      expect(response.status).toBe(200);
    }

    expect(seenLimits).toEqual([7, 7, undefined, undefined, undefined]);
    engine[Symbol.dispose]();
  });

  it('maps unknown aggregate attributes to Unprocessable instead of EngineFailure', async () => {
    const engine = new Engine({ storage: new MemoryStorage() });
    engine.register(
      workflow({ name: 'typed' })
        .searchAttributes({ knownAttribute: { type: 'string' } })
        .execute(async function* () {
          return 'ok';
        }),
    );

    const response = await handleRequest(
      new Request('http://localhost/v1/workflows/aggregate?group_by=attribute:unknownAttribute', {
        method: 'GET',
      }),
      engine,
      { operationRegistry: registry, restBindings: bindings },
    );

    expect(response.status).toBe(400);
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(await response.json()).toEqual({
      error:
        'Unknown search attribute "unknownAttribute". Aggregate groupBy requires a declared attribute.',
      retryable: false,
    });

    engine[Symbol.dispose]();
  });

  it('maps aggregate distinct-key cap errors to Unprocessable REST responses', async () => {
    const engine = new Engine({ storage: new MemoryStorage() });
    engine.aggregate = async () => {
      throw new AggregateDistinctKeyCapExceededError(3);
    };

    const response = await handleRequest(
      new Request('http://localhost/v1/workflows/aggregate?group_by=type', {
        method: 'GET',
      }),
      engine,
      { operationRegistry: registry, restBindings: bindings },
    );

    expect(response.status).toBe(400);
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(await response.json()).toEqual({
      error:
        'Aggregate query would exceed the distinct-key cap of 3. Narrow the filter or choose a lower-cardinality groupBy.',
      retryable: false,
    });

    engine[Symbol.dispose]();
  });

  it('masks unexpected aggregate failures in REST responses', async () => {
    const engine = new Engine({ storage: new MemoryStorage() });
    engine.aggregate = async () => {
      throw new Error('secret aggregate failure');
    };

    const response = await handleRequest(
      new Request('http://localhost/v1/workflows/aggregate?group_by=status', {
        method: 'GET',
      }),
      engine,
      { operationRegistry: registry, restBindings: bindings },
    );

    expect(response.status).toBe(500);
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(await response.json()).toEqual({ error: 'Internal server error', retryable: false });

    engine[Symbol.dispose]();
  });
});
