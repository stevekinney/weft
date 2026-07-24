import { afterEach, describe, expect, it } from 'bun:test';

import { Engine } from '../../core/engine.ts';
import { WorkflowFailedEvent } from '../../core/events.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { handleRequest } from '../handler.ts';
import { handleJsonRpcHttpRequest } from '../json-rpc-http.ts';
import { createOperationRegistry, executeOperation } from '../operation-catalog.ts';
import { principalFromApiKey } from '../principal.ts';
import { listAlertsOperation, listAlertsRestBinding } from './list-alerts.ts';

function createEngine(): Engine {
  return new Engine({
    storage: new MemoryStorage(),
    alerts: {
      rules: [
        {
          metric: 'workflow.failure_rate',
          threshold: 1,
          window: '5m',
          action: 'log',
        },
      ],
    },
  });
}

function authContext() {
  return {
    authContext: {
      method: 'api-key' as const,
      principal: principalFromApiKey({ subject: 'test', scopes: ['system:read'] }),
    },
  };
}

function jsonRpcRequest(): Request {
  return new Request('http://localhost/jsonrpc', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'weft.alerts.list', id: 1 }),
  });
}

describe('weft.alerts.list', () => {
  let engine: Engine | undefined;

  afterEach(() => {
    engine?.[Symbol.dispose]();
  });

  it('returns only currently firing alerts without exposing rule actions', async () => {
    engine = createEngine();
    engine.dispatchEvent(new WorkflowFailedEvent('workflow-1', new Error('failed')));

    const output = await executeOperation(
      'weft.alerts.list',
      {},
      {
        principal: authContext().authContext.principal,
        engine,
        transport: 'jsonRpcStdio',
        registry: createOperationRegistry([listAlertsOperation]),
      },
    );

    expect(output.ok).toBe(true);
    if (!output.ok) throw new Error('expected alert list to succeed');
    expect(output.value).toEqual({
      items: [
        {
          metric: 'workflow.failure_rate',
          threshold: 1,
          currentValue: 1,
          window: '5m',
          firedAt: expect.any(Number),
        },
      ],
    });
  });

  it('serves the same bounded shape through the REST binding', async () => {
    engine = createEngine();
    engine.dispatchEvent(new WorkflowFailedEvent('workflow-1', new Error('failed')));

    const response = await handleRequest(new Request('http://localhost/v1/alerts'), engine, {
      operationRegistry: createOperationRegistry([listAlertsOperation]),
      restBindings: [listAlertsRestBinding],
      ...authContext(),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      items: [
        {
          metric: 'workflow.failure_rate',
          threshold: 1,
          currentValue: 1,
          window: '5m',
          firedAt: expect.any(Number),
        },
      ],
    });
  });

  it('serves the same bounded shape through JSON-RPC HTTP', async () => {
    engine = createEngine();
    engine.dispatchEvent(new WorkflowFailedEvent('workflow-1', new Error('failed')));

    const response = await handleJsonRpcHttpRequest(jsonRpcRequest(), {
      registry: createOperationRegistry([listAlertsOperation]),
      engine,
      principal: authContext().authContext.principal,
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      jsonrpc: '2.0',
      id: 1,
      result: {
        items: [
          {
            metric: 'workflow.failure_rate',
            threshold: 1,
            currentValue: 1,
            window: '5m',
            firedAt: expect.any(Number),
          },
        ],
      },
    });
  });
});
