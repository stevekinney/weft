import { afterEach, describe, expect, it } from 'bun:test';
import { sleepForTesting } from '../testing/fake-timers.ts';

import { BunSQLiteStorage } from '../storage/bun-sql.ts';
import {
  createDiskBackedTestFixture,
  sqliteDatabaseSidecarSuffixes,
  type DiskBackedTestFixture,
} from '../testing/storage-backends.ts';
import { Engine } from './engine.ts';
import { tenantFromInputField, type TenantContext, type TenantResolver } from './tenant.ts';
import type { WorkflowContext } from './types.ts';

// ---------------------------------------------------------------------------
// Unit: helpers
// ---------------------------------------------------------------------------

describe('tenantFromInputField', () => {
  it('reads the tenant id from the configured field', () => {
    const resolver = tenantFromInputField('tenantId');
    expect(resolver.resolve('wf-1', { tenantId: 'acme' }, 'my-workflow')).toEqual({ id: 'acme' });
  });

  it('returns undefined when the field is missing', () => {
    const resolver = tenantFromInputField('tenantId');
    expect(resolver.resolve('wf-1', {}, 'my-workflow')).toBeUndefined();
  });

  it('returns undefined for non-object inputs', () => {
    const resolver = tenantFromInputField('tenantId');
    expect(resolver.resolve('wf-1', 'acme', 'my-workflow')).toBeUndefined();
    expect(resolver.resolve('wf-1', null, 'my-workflow')).toBeUndefined();
  });

  it('ignores empty string ids', () => {
    const resolver = tenantFromInputField('tenantId');
    expect(resolver.resolve('wf-1', { tenantId: '' }, 'my-workflow')).toBeUndefined();
  });

  it('coerces numeric ids to strings (auto-increment DB keys)', () => {
    const resolver = tenantFromInputField('tenantId');
    expect(resolver.resolve('wf-1', { tenantId: 12345 }, 'my-workflow')).toEqual({ id: '12345' });
    expect(resolver.resolve('wf-1', { tenantId: 0 }, 'my-workflow')).toEqual({ id: '0' });
  });

  it('rejects non-finite numeric ids', () => {
    const resolver = tenantFromInputField('tenantId');
    expect(resolver.resolve('wf-1', { tenantId: Number.NaN }, 'my-workflow')).toBeUndefined();
    expect(resolver.resolve('wf-1', { tenantId: Infinity }, 'my-workflow')).toBeUndefined();
  });

  it('returns undefined for unsupported value types (boolean, object)', () => {
    const resolver = tenantFromInputField('tenantId');
    expect(resolver.resolve('wf-1', { tenantId: true }, 'my-workflow')).toBeUndefined();
    expect(resolver.resolve('wf-1', { tenantId: { nested: 'x' } }, 'my-workflow')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Integration: engine exposes ctx.tenant
// ---------------------------------------------------------------------------

describe('Engine with tenantResolver', () => {
  // Track on-disk SQLite files created by tests below so we can delete them
  // even when an assertion failure interrupts the body of a test.
  const temporarySqliteFixtures: DiskBackedTestFixture[] = [];

  afterEach(() => {
    while (temporarySqliteFixtures.length > 0) {
      temporarySqliteFixtures.pop()!.cleanup();
    }
  });

  it('populates ctx.tenant for new workflows', async () => {
    const captured: Array<TenantContext | undefined> = [];
    const engine = new Engine({
      tenantResolver: {
        resolve: (_id, input) => {
          if (input === null || typeof input !== 'object') return undefined;
          const tenantId = (input as Record<string, unknown>)['tenantId'];
          return typeof tenantId === 'string'
            ? { id: tenantId, attributes: { tier: 'pro' } }
            : undefined;
        },
      },
    });

    engine.register('capture-tenant', async function* (ctx: WorkflowContext) {
      captured.push(ctx.tenant);
      return 'done';
    });

    const handle = await engine.start('capture-tenant', { tenantId: 'acme' });
    await handle.result();

    expect(captured).toHaveLength(1);
    expect(captured[0]).toEqual({ id: 'acme', attributes: { tier: 'pro' } });
  });

  it('leaves ctx.tenant undefined when the resolver returns undefined', async () => {
    const captured: Array<TenantContext | undefined> = [];
    const engine = new Engine({
      tenantResolver: {
        resolve: () => undefined,
      },
    });

    engine.register('capture-tenant', async function* (ctx: WorkflowContext) {
      captured.push(ctx.tenant);
      return 'done';
    });

    const handle = await engine.start('capture-tenant', { tenantId: 'acme' });
    await handle.result();
    expect(captured[0]).toBeUndefined();
  });

  it('awaits async resolvers', async () => {
    const resolver: TenantResolver = {
      resolve: async (_id, input) => {
        await sleepForTesting(1);
        if (input && typeof input === 'object' && 'tenantId' in input) {
          return { id: String((input as Record<string, unknown>)['tenantId']) };
        }
        return undefined;
      },
    };
    const engine = new Engine({ tenantResolver: resolver });
    const captured: Array<TenantContext | undefined> = [];
    engine.register('capture-tenant', async function* (ctx: WorkflowContext) {
      captured.push(ctx.tenant);
      return 'done';
    });

    const handle = await engine.start('capture-tenant', { tenantId: 'beta' });
    await handle.result();
    expect(captured[0]).toEqual({ id: 'beta' });
  });

  it('ctx.tenant is undefined when no resolver is configured', async () => {
    const captured: Array<TenantContext | undefined> = [];
    const engine = new Engine();

    engine.register('capture-tenant', async function* (ctx: WorkflowContext) {
      captured.push(ctx.tenant);
      return 'done';
    });

    const handle = await engine.start('capture-tenant', { tenantId: 'acme' });
    await handle.result();
    expect(captured[0]).toBeUndefined();
  });

  it('surfaces a resolver that throws as a rejection from engine.start()', async () => {
    const engine = new Engine({
      tenantResolver: {
        resolve() {
          throw new Error('tenant service unavailable');
        },
      },
    });
    engine.register('noop', async function* () {
      return 'done';
    });

    await expect(engine.start('noop', { tenantId: 'acme' })).rejects.toThrow(
      'tenant service unavailable',
    );

    // No partial workflow state should have been persisted.
    const listed = await engine.list();
    expect(listed.items.length).toBe(0);
  });

  it('ctx.tenant survives recovery across engine restart', async () => {
    // Use a shared on-disk path so a second engine can reopen the same storage.
    const fixture = createDiskBackedTestFixture({
      prefix: 'weft-tenant-recovery',
      suffix: '.sqlite',
      sidecarSuffixes: sqliteDatabaseSidecarSuffixes,
    });
    temporarySqliteFixtures.push(fixture);
    const workflowId = `wf-${crypto.randomUUID()}`;

    const resolver: TenantResolver = {
      resolve: () => ({ id: 'acme', attributes: { tier: 'pro' } }),
    };

    // First engine: start the workflow and let it park on a signal.
    const firstStorage = new BunSQLiteStorage(fixture.path);
    const firstEngine = new Engine({ storage: firstStorage, tenantResolver: resolver });

    firstEngine.register('park-and-capture', async function* (ctx: WorkflowContext) {
      const payload = yield* ctx.waitForSignal<{ ok: true }>('go');
      return { tenant: ctx.tenant, payload };
    });

    await firstEngine.start('park-and-capture', { note: 'initial' }, { id: workflowId });
    await sleepForTesting(10);

    // Tear the first engine down without completing the workflow.
    firstEngine[Symbol.dispose]();
    firstStorage[Symbol.dispose]();

    // Second engine: reopen the same storage. Intentionally do NOT configure a
    // resolver — the tenant must come back from persisted state.
    const secondStorage = new BunSQLiteStorage(fixture.path);
    const secondEngine = new Engine({ storage: secondStorage });

    secondEngine.register('park-and-capture', async function* (ctx: WorkflowContext) {
      const payload = yield* ctx.waitForSignal<{ ok: true }>('go');
      return { tenant: ctx.tenant, payload };
    });

    await secondEngine.recoverAll();
    const handle = secondEngine.getHandle(workflowId);
    const resultPromise = handle.result();

    await sleepForTesting(10);
    await secondEngine.signal(workflowId, 'go', { ok: true });

    const result = (await resultPromise) as {
      tenant: TenantContext | undefined;
      payload: { ok: true };
    };

    expect(result.tenant).toEqual({ id: 'acme', attributes: { tier: 'pro' } });
    expect(result.payload).toEqual({ ok: true });

    secondEngine[Symbol.dispose]();
    secondStorage[Symbol.dispose]();
  });
});
