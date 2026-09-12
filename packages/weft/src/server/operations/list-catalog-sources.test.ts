import { afterEach, describe, expect, it } from 'bun:test';

import { workflowSource } from '../../core/source/index.ts';
import { handleRequest } from '../handler.ts';
import { createOperationRegistry, executeOperation } from '../operation-catalog.ts';
import { principalFromApiKey } from '../principal.ts';
import { createLiveOperationRegistry } from '../rest-bindings.ts';
import {
  listCatalogSourcesOperation,
  listCatalogSourcesRestBinding,
} from './list-catalog-sources.ts';
import {
  assertOperationRejectsInsufficientScope,
  assertOperationRejectsUnauthenticated,
  createOperationTestEngine,
  systemReadAuthContext,
} from './operation-registry-test-helpers.test-support.ts';

const registry = createOperationRegistry([listCatalogSourcesOperation]);

function source(
  name: string,
  revision: string,
  load: () => Promise<Record<string, unknown>> = async () => ({}),
) {
  return workflowSource({ name, location: `./${name}.ts`, exportName: 'workflow', revision }, load);
}

describe('weft.catalog.sources.list — REST GET /v1/catalog/sources', () => {
  let engine: ReturnType<typeof createOperationTestEngine> | undefined;

  afterEach(() => {
    engine?.[Symbol.dispose]();
    engine = undefined;
  });

  it('lists dynamic sources, including idle revisions, in stable paginated order without loading', async () => {
    engine = createOperationTestEngine();
    let loadCount = 0;
    engine.registerSource(
      source('zeta', 'r2', async () => {
        loadCount += 1;
        return {};
      }),
    );
    engine.registerSource(
      source('zeta', 'r1', async () => {
        loadCount += 1;
        return {};
      }),
    );
    engine.registerSource(
      source('alpha', 'r1', async () => {
        loadCount += 1;
        return {};
      }),
    );

    const response = await handleRequest(
      new Request('http://localhost/v1/catalog/sources?limit=2'),
      engine,
      {
        operationRegistry: registry,
        restBindings: [listCatalogSourcesRestBinding],
        ...systemReadAuthContext(),
      },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      sources: [
        { name: 'alpha', revision: 'r1', kind: 'module', state: 'idle' },
        { name: 'zeta', revision: 'r1', kind: 'module', state: 'idle' },
      ],
      nextOffset: 2,
    });
    const next = await handleRequest(
      new Request('http://localhost/v1/catalog/sources?limit=2&offset=2'),
      engine,
      {
        operationRegistry: registry,
        restBindings: [listCatalogSourcesRestBinding],
        ...systemReadAuthContext(),
      },
    );
    expect(next.status).toBe(200);
    expect(await next.json()).toEqual({
      sources: [{ name: 'zeta', revision: 'r2', kind: 'module', state: 'idle' }],
    });
    expect(loadCount).toBe(0);
  });

  it('supports defaults, offsets, and rejects invalid pagination', async () => {
    engine = createOperationTestEngine();
    engine.registerSource(source('one', 'r1'));
    const result = await executeOperation(
      'weft.catalog.sources.list',
      { offset: 1 },
      {
        principal: principalFromApiKey({ subject: 'test', scopes: ['system:read'] }),
        engine,
        transport: 'jsonRpcStdio',
        registry,
      },
    );
    expect(result.ok && result.value).toEqual({ sources: [] });

    const invalid = await executeOperation(
      'weft.catalog.sources.list',
      { limit: 0 },
      {
        principal: principalFromApiKey({ subject: 'test', scopes: ['system:read'] }),
        engine,
        transport: 'jsonRpcStdio',
        registry,
      },
    );
    expect(invalid.ok).toBe(false);

    for (const query of [
      'limit=0',
      'limit=1001',
      'limit=1.5',
      'limit=nope',
      'offset=-1',
      'offset=1.5',
      'offset=nope',
    ]) {
      const response = await handleRequest(
        new Request(`http://localhost/v1/catalog/sources?${query}`),
        engine,
        {
          operationRegistry: registry,
          restBindings: [listCatalogSourcesRestBinding],
          ...systemReadAuthContext(),
        },
      );
      expect(response.status).toBe(400);
    }

    const defaultResponse = await handleRequest(
      new Request('http://localhost/v1/catalog/sources'),
      engine,
      {
        operationRegistry: registry,
        restBindings: [listCatalogSourcesRestBinding],
        ...systemReadAuthContext(),
      },
    );
    expect(await defaultResponse.json()).toEqual({
      sources: [{ name: 'one', revision: 'r1', kind: 'module', state: 'idle' }],
    });
  });

  it('returns empty for an engine without sources', async () => {
    engine = createOperationTestEngine();
    const response = await handleRequest(
      new Request('http://localhost/v1/catalog/sources'),
      engine,
      systemReadAuthContext(),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ sources: [] });
  });

  it('reports exact revision states without exposing failure details or descriptor content', async () => {
    engine = createOperationTestEngine();
    engine.registerSource(
      source('invoice', 'first', async () => {
        throw new Error('secret loader path');
      }),
    );
    engine.registerSource(source('invoice', 'second'));
    await expect(engine.workflows.preload('invoice', 'first')).rejects.toThrow();
    const response = await handleRequest(
      new Request('http://localhost/v1/catalog/sources'),
      engine,
      systemReadAuthContext(),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      sources: [
        { name: 'invoice', revision: 'first', kind: 'module', state: 'failed' },
        { name: 'invoice', revision: 'second', kind: 'module', state: 'idle' },
      ],
    });
  });

  it('uses system:read authorization and remains discoverable without MCP exposure', async () => {
    engine = createOperationTestEngine();
    await assertOperationRejectsUnauthenticated({
      operationName: 'weft.catalog.sources.list',
      engine,
      liveRegistry: createLiveOperationRegistry(),
    });
    await assertOperationRejectsInsufficientScope({
      operationName: 'weft.catalog.sources.list',
      engine,
      liveRegistry: createLiveOperationRegistry(),
    });
    const operation = createLiveOperationRegistry().get('weft.catalog.sources.list');
    expect(operation?.discoverable).toBe(true);
    expect(operation?.mcpExposable).toBe(false);
  });
});
