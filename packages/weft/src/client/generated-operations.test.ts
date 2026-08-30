/**
 * Regression coverage for the catalog-generated operation layer that both
 * {@link LocalClient} and {@link HttpClient} expose through `client.operations`
 * and `client.call(name, input)`.
 *
 * The point of this layer is full operation coverage without drift: every
 * catalog operation — including server operations the ergonomic surface does
 * not curate (workers, task queues, task diagnostics, system lease/metrics/registry,
 * checkpoints) — is reachable from JS, and new catalog operations appear here
 * automatically when the snapshot regenerates.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';

import {
  CATALOG_OPERATION_NAMES,
  CLIENT_OPERATION_NAMES,
} from '../cli/generated/operation-client.generated.ts';
import { encode } from '../core/codec.ts';
import { Engine } from '../core/engine.ts';
import { encodeScheduleRunMetadata } from '../core/engine/schedule-run-metadata.ts';
import type { WorkflowContext } from '../core/types.ts';
import { workflow } from '../core/types.ts';
import { serve, type WeftServer } from '../server/index.ts';
import {
  encodeRemoteTaskRecord,
  taskLedgerKey,
  type RemoteTaskDeadLettered,
  type RemoteTaskQueued,
  type RemoteTaskTerminalResolved,
} from '../server/task-ledger.ts';
import { KEYS } from '../storage/interface.ts';
import { MemoryStorage } from '../storage/memory.ts';
import { HttpClient } from './http-client.ts';
import { LocalClient } from './local.ts';

// Operations that exist on the catalog but NOT on the curated ergonomic
// WeftClient interface. Reaching these from the client is the whole point of
// the generated layer — they used to require hand-built raw calls.
const UNCURATED_CATALOG_OPERATIONS = [
  'weft.storage.capabilities',
  'weft.system.lease',
  'weft.system.metrics',
  'weft.system.registry',
  'weft.workers.list',
  'weft.task.queues.list',
  'weft.tasks.diagnostics',
  'weft.workflows.checkpoints.list',
  'weft.workflows.checkpoints.get',
] as const;

const REST_ONLY_OPERATION = 'weft.tasks.diagnostics.deadletters.clear' as const;

/** Seed a minimal `deadLettered` ledger record so `REST_ONLY_OPERATION` has something to clear (WFT-24: the operation reads the durable ledger, not the retired `KEYS.operationDeadLetter` marker key). */
function deadLetteredLedgerFixture(operationId: string): RemoteTaskDeadLettered {
  return {
    recordVersion: 1,
    operationId,
    workflowType: 'test',
    activityName: 'charge',
    queue: 'default',
    input: null,
    headers: {},
    visibilityTimeoutMilliseconds: 30_000,
    createdAt: 0,
    generation: 3,
    state: 'deadLettered',
    attemptToken: 'attempt-token',
    attempt: 1,
    pendingStatus: 'completed',
    pendingResultDigest: 'digest-1',
    retryCount: 0,
    requeueCount: 0,
    deadLetteredAt: 0,
    persistenceFailureReason: 'lost the compare-and-swap race',
  };
}

function delayedLedgerFixture(operationId: string, availableAt: number): RemoteTaskQueued {
  return {
    recordVersion: 1,
    operationId,
    workflowId: 'workflow-diagnostics',
    workflowType: 'test',
    activityName: 'charge',
    queue: 'payments',
    input: null,
    headers: {},
    visibilityTimeoutMilliseconds: 30_000,
    createdAt: 0,
    generation: 0,
    state: 'queued',
    attempt: 2,
    availableAt,
    firstQueuedAt: 0,
    lastQueuedAt: 0,
    retryCount: 1,
    requeueCount: 1,
  };
}

function unadoptedTerminalLedgerFixture(
  operationId: string,
  terminalAt: number,
): RemoteTaskTerminalResolved {
  return {
    recordVersion: 1,
    operationId,
    workflowId: 'workflow-diagnostics',
    workflowType: 'test',
    activityName: 'charge',
    queue: 'payments',
    input: null,
    headers: {},
    visibilityTimeoutMilliseconds: 30_000,
    createdAt: 0,
    generation: 2,
    state: 'terminal',
    disposition: 'resolved',
    attempt: 1,
    attemptToken: 'attempt-token',
    status: 'completed',
    resultDigest: 'digest',
    terminalAt,
    adopted: false,
    retentionGeneration: 0,
  };
}

describe('LocalClient catalog operations', () => {
  it('exposes a typed accessor covering every client-callable operation', () => {
    const engine = new Engine({ storage: new MemoryStorage() });
    const client = new LocalClient(engine);
    try {
      for (const name of CLIENT_OPERATION_NAMES) {
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

  it('routes lease health through the generated in-process operation client', async () => {
    const engine = new Engine({ storage: new MemoryStorage() });
    const client = new LocalClient(engine);
    try {
      await expect(client.operations['weft.system.lease']({})).resolves.toEqual({
        mode: 'none',
        status: 'disabled',
        holdsLease: false,
      });
      await expect(client.call('weft.system.lease', {})).resolves.toEqual({
        mode: 'none',
        status: 'disabled',
        holdsLease: false,
      });
    } finally {
      engine[Symbol.dispose]();
    }
  });

  it('routes an ordinary REST-only operation through the in-process operation pipeline', async () => {
    const engine = new Engine({ storage: new MemoryStorage() });
    const client = new LocalClient(engine);
    const operationId = 'local-dead-letter';
    try {
      await engine.storage.put(
        taskLedgerKey(operationId),
        encodeRemoteTaskRecord(deadLetteredLedgerFixture(operationId)),
      );
      await expect(client.call(REST_ONLY_OPERATION, { operationId })).resolves.toEqual({
        ok: true,
      });
      expect(await engine.storage.get(taskLedgerKey(operationId))).toBeNull();
    } finally {
      engine[Symbol.dispose]();
    }
  });

  it('exposes raw storage through the byte-oriented local storage facade', async () => {
    const engine = new Engine({ storage: new MemoryStorage() });
    const client = new LocalClient(engine);
    try {
      await client.storage.put('client:a', new Uint8Array([1, 2]));
      await client.storage.batch([{ type: 'put', key: 'client:b', value: new Uint8Array([3]) }]);
      expect(await client.storage.get('client:a')).toEqual(new Uint8Array([1, 2]));
      await expect(Array.fromAsync(client.storage.scan('client:'))).resolves.toEqual([
        ['client:a', new Uint8Array([1, 2])],
        ['client:b', new Uint8Array([3])],
      ]);
      await expect(
        client.storage.conditionalBatch(
          [{ key: 'client:c', expectedValue: null }],
          [{ type: 'put', key: 'client:c', value: new Uint8Array([4]) }],
        ),
      ).resolves.toBe(true);
      await client.storage.delete('client:a');
      expect(await client.storage.get('client:a')).toBeNull();
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

  it('reports the local engine storage capability profile', async () => {
    const storage = new MemoryStorage();
    const engine = new Engine({ storage });
    const client = new LocalClient(engine);
    try {
      await expect(client.operations['weft.storage.capabilities']({})).resolves.toEqual(
        storage.capabilities(),
      );
      await expect(client.call('weft.storage.capabilities', {})).resolves.toEqual(
        storage.capabilities(),
      );
    } finally {
      engine[Symbol.dispose]();
    }
  });

  it('reads workflow provenance and finalizer progress through generated local operations', async () => {
    const engine = new Engine({ storage: new MemoryStorage() });
    const client = new LocalClient(engine);
    try {
      await engine.storage.put(
        KEYS.scheduleRunLink('local-observed-run'),
        encodeScheduleRunMetadata('local-schedule', 1_000),
      );
      await engine.storage.put(
        KEYS.teardownOwed('local-observed-run'),
        encode({ status: 'owed', attempts: 1, token: 'claim' }),
      );

      await expect(
        client.operations['weft.workflows.scheduleprovenance.get']({
          workflowId: 'local-observed-run',
        }),
      ).resolves.toEqual({ scheduleId: 'local-schedule', occurrence: 1_000 });
      await expect(
        client.operations['weft.workflows.finalizer.get']({ workflowId: 'local-observed-run' }),
      ).resolves.toEqual({ status: 'pending', attempts: 1 });
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
          'storage:read',
          'workflows:read',
          'workflows:write',
          'workflows:admin',
          'system:admin',
          'storage:admin',
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

  it('exposes a typed accessor covering every client-callable operation', () => {
    for (const name of CLIENT_OPERATION_NAMES) {
      expect(client.operations[name]).toBeFunction();
    }
  });

  it('routes a previously-unexposed op (get-system-metrics) over JSON-RPC', async () => {
    await expect(client.operations['weft.system.metrics']({})).resolves.toBeDefined();
    await expect(client.call('weft.system.metrics', {})).resolves.toBeDefined();
  });

  it('routes lease health over JSON-RPC', async () => {
    await expect(client.operations['weft.system.lease']({})).resolves.toEqual({
      mode: 'none',
      status: 'disabled',
      holdsLease: false,
    });
    await expect(client.call('weft.system.lease', {})).resolves.toEqual({
      mode: 'none',
      status: 'disabled',
      holdsLease: false,
    });
  });

  it('returns typed delayed and unadopted-terminal diagnostics over REST and generated JSON-RPC', async () => {
    const capturedNow = Date.now();
    const delayed = delayedLedgerFixture('http-delayed', capturedNow + 30_000);
    const unadopted = unadoptedTerminalLedgerFixture('http-unadopted', capturedNow - 120_000);
    await engine.storage.put(taskLedgerKey(delayed.operationId), encodeRemoteTaskRecord(delayed));
    await engine.storage.put(
      taskLedgerKey(unadopted.operationId),
      encodeRemoteTaskRecord(unadopted),
    );

    const input = {
      workflowId: 'workflow-diagnostics',
      queue: 'payments',
      includeExpectedDelayed: true,
      unadoptedAfterMs: 60_000,
      staleQueuedAfterMs: 60_000,
      staleHeartbeatAfterMs: 60_000,
      retryStormMinimumAttempts: 3,
      limit: 50,
    };
    const jsonRpcResult = await client.operations['weft.tasks.diagnostics'](input);
    const restResponse = await fetch(
      `${server.url}/v1/tasks/diagnostics?workflowId=workflow-diagnostics&queue=payments&includeExpectedDelayed=true&unadoptedAfterMs=60000`,
      { headers: { Authorization: 'Bearer catalog-ops-secret' } },
    );
    expect(restResponse.status).toBe(200);
    const restResult = (await restResponse.json()) as typeof jsonRpcResult;

    for (const result of [jsonRpcResult, restResult]) {
      expect(result.summary.delayed).toBe(1);
      expect(result.summary.unadoptedTerminal).toBe(1);
      expect(result.items).toContainEqual({
        kind: 'delayed',
        state: 'queued',
        operationId: 'http-delayed',
        workflowId: 'workflow-diagnostics',
        queue: 'payments',
        retryCount: 1,
        requeueCount: 1,
        availableAt: delayed.availableAt,
        evidence: [`Task is delayed until ${delayed.availableAt} on queue "payments"`],
      });
      expect(result.items).toContainEqual(
        expect.objectContaining({
          kind: 'unadopted-terminal',
          state: 'resolved',
          operationId: 'http-unadopted',
          workflowId: 'workflow-diagnostics',
          queue: 'payments',
          terminalAt: unadopted.terminalAt,
          adopted: false,
        }),
      );
    }

    const excludedResponse = await fetch(
      `${server.url}/v1/tasks/diagnostics?operationId=http-delayed&includeExpectedDelayed=false`,
      { headers: { Authorization: 'Bearer catalog-ops-secret' } },
    );
    expect(excludedResponse.status).toBe(200);
    const excludedResult = (await excludedResponse.json()) as typeof jsonRpcResult;
    expect(excludedResult.summary.delayed).toBe(0);
    expect(excludedResult.items).toEqual([]);
  });

  it('routes get-system-registry over JSON-RPC', async () => {
    const registry = await client.operations['weft.system.registry']({});
    expect(registry).toMatchObject({ registryVersion: expect.any(Number) });
  });

  it('reports the remote engine storage capability profile over JSON-RPC', async () => {
    await expect(client.operations['weft.storage.capabilities']({})).resolves.toEqual(
      engine.storage.capabilities(),
    );
    await expect(client.call('weft.storage.capabilities', {})).resolves.toEqual(
      engine.storage.capabilities(),
    );
  });

  it('reads workflow provenance and finalizer progress through generated JSON-RPC operations', async () => {
    await engine.storage.put(
      KEYS.scheduleRunLink('http-observed-run'),
      encodeScheduleRunMetadata('http-schedule', 2_000),
    );
    await engine.storage.put(
      KEYS.teardownOwed('http-observed-run'),
      encode({ status: 'running', attempts: 1, token: 'claim', claimedAt: 1_500 }),
    );

    await expect(
      client.operations['weft.workflows.scheduleprovenance.get']({
        workflowId: 'http-observed-run',
      }),
    ).resolves.toEqual({ scheduleId: 'http-schedule', occurrence: 2_000 });
    await expect(
      client.operations['weft.workflows.finalizer.get']({ workflowId: 'http-observed-run' }),
    ).resolves.toEqual({ status: 'running', attempts: 2, startedAt: 1_500 });
  });

  it('routes an ordinary REST-only operation through generated binding metadata', async () => {
    const operationId = 'http/dead letter';
    await engine.storage.put(
      taskLedgerKey(operationId),
      encodeRemoteTaskRecord(deadLetteredLedgerFixture(operationId)),
    );

    await expect(client.operations[REST_ONLY_OPERATION]({ operationId })).resolves.toEqual({
      ok: true,
    });
    expect(await engine.storage.get(taskLedgerKey(operationId))).toBeNull();
  });

  it('preserves HttpClientError shaping for REST-only operation authorization failures', async () => {
    const { HttpClientError } = await import('./http-request.ts');
    const unauthenticatedClient = new HttpClient({ baseUrl: server.url, headers: {} });
    const caught = await unauthenticatedClient
      .call(REST_ONLY_OPERATION, { operationId: 'forbidden' })
      .catch((error: unknown) => error);

    expect(caught).toBeInstanceOf(HttpClientError);
    if (!(caught instanceof HttpClientError)) throw new Error('unreachable');
    expect(caught.status).toBe(401);
  });

  it('exposes raw storage through the byte and NDJSON-aware HTTP storage facade', async () => {
    await client.storage.put('client:a/slash', new Uint8Array([1, 2]));
    await client.storage.batch([{ type: 'put', key: 'client:b', value: new Uint8Array([3]) }]);
    expect(await client.storage.get('client:a/slash')).toEqual(new Uint8Array([1, 2]));
    await expect(Array.fromAsync(client.storage.scan('client:'))).resolves.toEqual([
      ['client:a/slash', new Uint8Array([1, 2])],
      ['client:b', new Uint8Array([3])],
    ]);
    await expect(
      client.storage.conditionalBatch(
        [{ key: 'client:c', expectedValue: null }],
        [{ type: 'put', key: 'client:c', value: new Uint8Array([4]) }],
      ),
    ).resolves.toBe(true);
    await client.storage.delete('client:a/slash');
    expect(await client.storage.get('client:a/slash')).toBeNull();
  });

  it('preserves HttpClientError shaping for raw storage authorization failures', async () => {
    const { HttpClientError } = await import('./http-request.ts');
    const unauthenticatedClient = new HttpClient({ baseUrl: server.url, headers: {} });
    const caught = await unauthenticatedClient.storage
      .put('forbidden', new Uint8Array([1]))
      .catch((error: unknown) => error);

    expect(caught).toBeInstanceOf(HttpClientError);
    if (!(caught instanceof HttpClientError)) throw new Error('unreachable');
    expect(caught.status).toBe(401);
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
  // Production REST bindings use a separate additive flat
  // `{ error, weftCode?, data? }` projection. Its live HttpClient round trips
  // and stricter disclosure allowlist are covered in `index.test.ts` and the
  // REST fault-shaper regression suite; these tests pin JSON-RPC's broader
  // envelope without conflating the two contracts.
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

    it('withholds data for an unauthenticated live REST fault response', async () => {
      // Authentication reasons are intentionally excluded from REST's audited
      // data projection. The flat body also carries no coarse FaultCode.
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
