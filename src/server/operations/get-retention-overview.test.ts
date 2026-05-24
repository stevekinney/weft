import { afterEach, describe, expect, it } from 'bun:test';

import { Engine } from '../../core/engine.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { handleRequest } from '../handler.ts';
import { createOperationRegistry } from '../operation-catalog.ts';
import type { OperationFault } from '../operation-fault.ts';
import {
  getRetentionOverviewOperation,
  getRetentionOverviewRestBinding,
} from './get-retention-overview.ts';

function createEngine(): Engine {
  return new Engine({ storage: new MemoryStorage() });
}

const registry = createOperationRegistry([getRetentionOverviewOperation]);

describe('weft.retention.get', () => {
  let engine: Engine | undefined;

  afterEach(() => {
    engine?.[Symbol.dispose]();
  });

  it('returns the retention overview on the happy path', async () => {
    engine = createEngine();
    const expected = engine.getRetentionOverview();

    const response = await handleRequest(
      new Request('http://localhost/v1/retention', { method: 'GET' }),
      engine,
      {
        operationRegistry: registry,
        restBindings: [getRetentionOverviewRestBinding],
      },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(await response.json()).toEqual(expected);
  });

  it('masks EngineFailure faults to a 500 with a generic error body', async () => {
    engine = createEngine();

    const failingOperation = {
      ...getRetentionOverviewOperation,
      invoke: async () => {
        const fault: OperationFault = {
          code: 'EngineFailure',
          message: 'secret internal detail',
          data: {},
        };
        throw fault;
      },
    };

    const response = await handleRequest(
      new Request('http://localhost/v1/retention', { method: 'GET' }),
      engine,
      {
        operationRegistry: createOperationRegistry([failingOperation]),
        restBindings: [getRetentionOverviewRestBinding],
      },
    );

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Internal server error' });
  });
});
