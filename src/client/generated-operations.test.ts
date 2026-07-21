/**
 * Regression coverage for the catalog-generated operation layer that both
 * {@link LocalClient} and {@link HttpClient} expose through `client.operations`
 * and `client.call(name, input)`.
 *
 * The point of this layer is full operation coverage without drift: every
 * catalog operation — including server operations the ergonomic surface does
 * not curate (workers, task queues, task diagnostics, system metrics/registry,
 * checkpoints) — is reachable from JS, and new catalog operations appear here
 * automatically when the snapshot regenerates.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';

import { CATALOG_OPERATION_NAMES } from '../cli/generated/operation-client.generated.ts';
import { Engine } from '../core/engine.ts';
import type { WorkflowContext } from '../core/types.ts';
import { workflow } from '../core/types.ts';
import { serve, type WeftServer } from '../server/index.ts';
import { MemoryStorage } from '../storage/memory.ts';
import { HttpClient } from './http-client.ts';
import { LocalClient } from './local.ts';

// Operations that exist on the catalog but NOT on the curated ergonomic
// WeftClient interface. Reaching these from the client is the whole point of
// the generated layer — they used to require hand-built raw calls.
const UNCURATED_CATALOG_OPERATIONS = [
  'weft.system.metrics',
  'weft.system.registry',
  'weft.workers.list',
  'weft.task.queues.list',
  'weft.tasks.diagnostics',
  'weft.workflows.checkpoints.list',
  'weft.workflows.checkpoints.get',
] as const;

describe('LocalClient catalog operations', () => {
  it('exposes a typed accessor covering every catalog operation', () => {
    const engine = new Engine({ storage: new MemoryStorage() });
    const client = new LocalClient(engine);
    try {
      for (const name of CATALOG_OPERATION_NAMES) {
        expect(client.operations[name]).toBeFunction();
      }
      // Full coverage: the catalog is strictly larger than the curated surface.
      expect(CATALOG_OPERATION_NAMES.length).toBeGreaterThan(41);
    } finally {
      engine[Symbol.dispose]();
    }
  });

  it('reaches uncurated server operations through operations and call()', () => {
    const engine = new Engine({ storage: new MemoryStorage() });
    const client = new LocalClient(engine);
    try {
      for (const name of UNCURATED_CATALOG_OPERATIONS) {
        expect(client.operations[name]).toBeFunction();
      }
    } finally {
      engine[Symbol.dispose]();
    }
  });

  it('routes a previously-unexposed op (get-system-metrics) to the in-process engine', async () => {
    const engine = new Engine({ storage: new MemoryStorage() });
    const client = new LocalClient(engine);
    try {
      await expect(client.operations['weft.system.metrics']({})).resolves.toBeDefined();
      // call() resolves the same operation by name with identical typing.
      await expect(client.call('weft.system.metrics', {})).resolves.toBeDefined();
    } finally {
      engine[Symbol.dispose]();
    }
  });

  it('routes get-system-registry to the in-process engine registry', async () => {
    const engine = new Engine({ storage: new MemoryStorage() });
    engine.register(
      workflow({ name: 'catalog-ops-noop' }).execute(async function* (_ctx: WorkflowContext) {}),
    );
    const client = new LocalClient(engine);
    try {
      const registry = await client.operations['weft.system.registry']({});
      expect(registry).toMatchObject({ registryVersion: expect.any(Number) });
    } finally {
      engine[Symbol.dispose]();
    }
  });

  it('surfaces operation faults as thrown errors (drift: bulk-delete validation)', async () => {
    const engine = new Engine({ storage: new MemoryStorage() });
    const client = new LocalClient(engine);
    try {
      // bulk.delete requires a confirmation token / dry-run discipline; an empty
      // unfiltered request is rejected by the operation pipeline. The point is
      // that the in-process transport throws rather than silently resolving.
      await expect(client.operations['weft.workflows.bulk.delete']({})).rejects.toThrow();
    } finally {
      engine[Symbol.dispose]();
    }
  });
});

describe('HttpClient catalog operations', () => {
  let engine: Engine;
  let server: WeftServer;
  let client: HttpClient;

  beforeAll(() => {
    engine = new Engine({ storage: new MemoryStorage() });
    // serve() mounts the POST /jsonrpc transport that the generated catalog
    // client speaks; the bare handleRequest REST table does not. The api-key
    // auth grants the scopes the uncurated system operations require.
    server = serve({
      engine,
      port: 0,
      auth: {
        apiKeys: ['catalog-ops-secret'],
        defaultApiKeyScopes: [
          'system:read',
          'workflows:read',
          'workflows:write',
          'workflows:admin',
        ],
      },
    });
    client = new HttpClient({
      baseUrl: server.url,
      headers: { Authorization: 'Bearer catalog-ops-secret' },
    });
  });

  afterAll(async () => {
    await server.stop();
    await engine[Symbol.asyncDispose]();
  });

  it('exposes a typed accessor covering every catalog operation', () => {
    for (const name of CATALOG_OPERATION_NAMES) {
      expect(client.operations[name]).toBeFunction();
    }
  });

  it('routes a previously-unexposed op (get-system-metrics) over JSON-RPC', async () => {
    await expect(client.operations['weft.system.metrics']({})).resolves.toBeDefined();
    await expect(client.call('weft.system.metrics', {})).resolves.toBeDefined();
  });

  it('routes get-system-registry over JSON-RPC', async () => {
    const registry = await client.operations['weft.system.registry']({});
    expect(registry).toMatchObject({ registryVersion: expect.any(Number) });
  });

  it('reaches an uncurated workflow op (list) through the generated layer', async () => {
    const result = await client.call('weft.workflows.list', {});
    expect(result).toMatchObject({ items: expect.any(Array) });
  });

  it('surfaces JSON-RPC operation faults as thrown errors', async () => {
    // weft.workflows.get on a missing id produces a NotFound fault, which the
    // catalog transport rethrows rather than returning a success envelope.
    await expect(
      client.operations['weft.workflows.get']({ workflowId: 'catalog-ops-missing' }),
    ).rejects.toThrow();
  });

  it('uses data.httpStatus from the JSON-RPC error envelope, not the always-200 HTTP response', async () => {
    // The /jsonrpc endpoint always returns HTTP 200 on operation faults.
    // HttpClientError.status must reflect the fault's logical HTTP status
    // taken from error.data.httpStatus in the envelope (e.g. 404 for NotFound).
    try {
      await client.operations['weft.workflows.get']({ workflowId: 'catalog-ops-status-check' });
      throw new Error('Expected operation to throw');
    } catch (err) {
      const { HttpClientError } = await import('./http-request.ts');
      expect(err).toBeInstanceOf(HttpClientError);
      if (err instanceof HttpClientError) {
        // NotFound maps to HTTP 404, not 200.
        expect(err.status).toBe(404);
        expect(err.faultCode).toBe('NotFound');
      }
    }
  });

  it('surfaces transport-level non-JSON responses as HttpClientError', async () => {
    // A URL that does not speak JSON-RPC returns a plain-text body. The transport
    // must surface it as HttpClientError rather than letting response.json() throw
    // a raw SyntaxError.
    const { httpClientCatalogTransport } = await import('./http-operations.ts');
    const { HttpClientError } = await import('./http-request.ts');
    // Point at /v1 which returns non-JSON for an unexpected POST.
    const nonJsonTransport = httpClientCatalogTransport(`${server.url}/v1`, {
      Authorization: 'Bearer catalog-ops-secret',
    });
    const err = await nonJsonTransport('weft.system.metrics', {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpClientError);
  });

  // #711: HttpClientError.data must round-trip the fault's typed wire payload
  // over JSON-RPC-over-HTTP so weft-console can build field-level and
  // resource-linked fault UI without hand-parsing.
  //
  // REST is deliberately NOT covered here with a live round trip. Every
  // production REST binding supplies `shapeFault: shapeRestFault` (or a
  // shaper that delegates to it), and `shapeRestFault` emits a flat
  // `{ error, weftCode? }` body — it never puts a `data` object on the wire
  // for ANY fault code, not just the masked `EngineFailure`. `faultCode` does
  // not even survive the REST trip today (only the human `message` and, when
  // set, a fine-grained `weftCode` sibling do). `HttpClientError.data`'s REST
  // parsing path is proven correct against the nested `{ error: { data } }`
  // shape in `http-request.test.ts` — that shape is real (it is what
  // `faultToHttpResponse` emits, and the type guards in `http-request.ts`
  // handle it defensively for forward compatibility) but is not the shape any
  // current production REST binding sends. Delivering `data` over REST
  // requires changing `shapeRestFault`'s wire contract across ~30 operations
  // and re-auditing what each fault discloses — out of scope here; tracked in
  // https://github.com/stevekinney/weft/issues/720.
  describe('HttpClientError.data (#711)', () => {
    it('round-trips InvalidParams field issues from a real Zod schema failure over JSON-RPC', async () => {
      const { HttpClientError } = await import('./http-request.ts');
      // `operation` fails the top-level `z.enum(['add', 'remove'])` schema
      // check before `invoke()` runs, so the server emits a REAL flattened
      // Zod issue (not the empty-array shape hand-thrown faults use).
      const caught = await client
        .call('weft.workflows.bulk.tags', { tags: ['a'], operation: 'bogus' } as never)
        .catch((error: unknown) => error);

      expect(caught).toBeInstanceOf(HttpClientError);
      if (!(caught instanceof HttpClientError)) throw new Error('unreachable');
      expect(caught.faultCode).toBe('InvalidParams');
      const issues = caught.data?.['issues'];
      expect(Array.isArray(issues)).toBe(true);
      const issueArray = issues as Array<{ path: unknown[]; message: string; code: string }>;
      expect(issueArray.length).toBeGreaterThan(0);
      expect(issueArray[0]).toMatchObject({
        path: ['operation'],
        message: expect.any(String),
        code: expect.any(String),
      });
    });

    it('round-trips NotFound resource/identifier over JSON-RPC', async () => {
      const { HttpClientError } = await import('./http-request.ts');
      const caught = await client.operations['weft.workflows.get']({
        workflowId: 'catalog-ops-data-notfound-jsonrpc',
      }).catch((error: unknown) => error);

      expect(caught).toBeInstanceOf(HttpClientError);
      if (!(caught instanceof HttpClientError)) throw new Error('unreachable');
      expect(caught.faultCode).toBe('NotFound');
      expect(caught.data).toMatchObject({
        resource: 'workflow',
        identifier: 'catalog-ops-data-notfound-jsonrpc',
      });
    });

    it('leaves data (and faultCode) undefined over a live REST fault response', async () => {
      // A live `shapeRestFault` response — here, a real 401 from an
      // unauthenticated request — never carries `data` (or even `faultCode`)
      // over REST today, confirming the boundary documented above holds
      // against the real server, not just the mocked bodies in
      // `http-request.test.ts`.
      const { HttpClientError } = await import('./http-request.ts');
      const unauthenticatedClient = new HttpClient({ baseUrl: server.url, headers: {} });
      const caught = await unauthenticatedClient
        .cancel('catalog-ops-unauthenticated')
        .catch((error: unknown) => error);

      expect(caught).toBeInstanceOf(HttpClientError);
      if (!(caught instanceof HttpClientError)) throw new Error('unreachable');
      expect(caught.status).toBe(401);
      expect(caught.faultCode).toBeUndefined();
      expect(caught.data).toBeUndefined();
    });
  });
});
