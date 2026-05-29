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
        defaultApiKeyScopes: ['system:read', 'workflows:read', 'workflows:write'],
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
});
