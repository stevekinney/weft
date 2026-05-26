import { afterEach, describe, expect, it } from 'bun:test';

import {
  KEYS,
  type BatchOperation,
  type ConditionalBatchCondition,
  type Storage as WeftStorage,
} from '../storage/interface.ts';
import { MemoryStorage } from '../storage/memory.ts';
import { decode, encode } from './codec.ts';
import { Engine } from './engine.ts';
import { buildTimerBatchOperations } from './scheduler.ts';
import { QuotaExceededError, TenantQuotaManager } from './tenant-quotas.ts';
import { tenantFromInputField } from './tenant.ts';
import type { TenantQuotaOptions, WorkflowContext } from './types.ts';
import { workflow } from './types.ts';

const storageByteEncoder = new TextEncoder();

class BarrierConditionalBatchMemoryStorage extends MemoryStorage {
  failedConditionalBatches = 0;
  conditionalBatchCalls = 0;
  readonly #barrierKeys: Set<string>;
  readonly #barrierState = new Map<
    string,
    { active: boolean; waiters: number; release: (() => void) | null }
  >();

  constructor(barrierKeys: Iterable<string>) {
    super();
    this.#barrierKeys = new Set(barrierKeys);
  }

  override async get(key: string): Promise<Uint8Array | null> {
    if (this.#barrierKeys.has(key)) {
      await this.#waitForBarrier(`get:${key}`);
    }

    return super.get(key);
  }

  override async *scan(
    prefix: string,
    options?: Parameters<MemoryStorage['scan']>[1],
  ): AsyncIterable<[string, Uint8Array]> {
    if (prefix === 'wf:') {
      await this.#waitForBarrier('scan:wf:');
    }

    for await (const entry of super.scan(prefix, options)) {
      yield entry;
    }
  }

  override async conditionalBatch(
    conditions: ConditionalBatchCondition[],
    operations: BatchOperation[],
  ): Promise<boolean> {
    this.conditionalBatchCalls++;

    const committed = await super.conditionalBatch(conditions, operations);
    if (!committed) {
      this.failedConditionalBatches++;
    }
    return committed;
  }

  async #waitForBarrier(name: string): Promise<void> {
    const state = this.#barrierState.get(name) ?? {
      active: true,
      waiters: 0,
      release: null,
    };
    if (!state.active) {
      return;
    }

    state.waiters++;
    this.#barrierState.set(name, state);

    if (state.waiters === 2) {
      state.active = false;
      state.release?.();
      state.release = null;
      return;
    }

    await new Promise<void>((resolve) => {
      state.release = resolve;
    });
  }
}

class WorkflowScanTrackingStorage extends MemoryStorage {
  workflowScanCount = 0;
  nestedWorkflowPrefixes: string[] = [];

  override async *scan(
    prefix: string,
    options?: Parameters<MemoryStorage['scan']>[1],
  ): AsyncIterable<[string, Uint8Array]> {
    if (prefix === 'wf:') {
      this.workflowScanCount++;
    } else if (prefix.startsWith('wf:')) {
      this.nestedWorkflowPrefixes.push(prefix);
    }

    for await (const entry of super.scan(prefix, options)) {
      yield entry;
    }
  }
}

class TerminalTransitionBarrierStorage extends MemoryStorage {
  sawConcurrentWorkflowRead = false;
  readonly #workflowKey: string;
  #armed = false;
  #blockingTransitionWrite = false;
  #blockedTransitionSeen = false;
  readonly #blockedWrite = Promise.withResolvers<void>();
  readonly #releaseWrite = Promise.withResolvers<void>();

  constructor(workflowId: string) {
    super();
    this.#workflowKey = KEYS.workflow(workflowId);
  }

  arm(): void {
    this.#armed = true;
  }

  async waitForBlockedTransitionWrite(): Promise<void> {
    await this.#blockedWrite.promise;
  }

  releaseBlockedTransitionWrite(): void {
    this.#releaseWrite.resolve();
  }

  override async get(key: string): Promise<Uint8Array | null> {
    if (this.#armed && this.#blockingTransitionWrite && key === this.#workflowKey) {
      this.sawConcurrentWorkflowRead = true;
    }

    return super.get(key);
  }

  override async conditionalBatch(
    conditions: ConditionalBatchCondition[],
    operations: BatchOperation[],
  ): Promise<boolean> {
    if (
      this.#armed &&
      !this.#blockedTransitionSeen &&
      operations.some(
        (operation) => operation.type === 'put' && operation.key === this.#workflowKey,
      )
    ) {
      this.#blockedTransitionSeen = true;
      this.#blockingTransitionWrite = true;
      this.#blockedWrite.resolve();
      await this.#releaseWrite.promise;
      this.#blockingTransitionWrite = false;
    }

    return super.conditionalBatch(conditions, operations);
  }
}

function measureStoredRecordBytes(key: string, value: Uint8Array): number {
  return storageByteEncoder.encode(key).byteLength + value.byteLength;
}

function createEngine(parameters?: {
  now?: () => number;
  quotas?: TenantQuotaOptions;
  storage?: WeftStorage;
}): Engine {
  const engineOptions: NonNullable<ConstructorParameters<typeof Engine>[0]> = {
    storage: parameters?.storage ?? new MemoryStorage(),
    tenantResolver: tenantFromInputField('tenantId'),
  };
  if (parameters?.now) {
    engineOptions.getNow = parameters.now;
  }
  if (parameters?.quotas) {
    engineOptions.quotas = parameters.quotas;
  }

  const engine = new Engine(engineOptions);

  const holdWorkflow = workflow({ name: 'hold' }).execute(async function* (
    context: WorkflowContext,
    input: unknown,
  ) {
    const payload =
      input !== null && typeof input === 'object' && 'payload' in input
        ? (input as { payload?: string }).payload
        : undefined;
    yield* context.waitForSignal('release');
    return payload ?? 'released';
  });
  engine.register(holdWorkflow);

  const echoWorkflow = workflow({ name: 'echo' }).execute(async function* (
    _context: WorkflowContext,
    input: unknown,
  ) {
    return input;
  });
  engine.register(echoWorkflow);

  const explodeWorkflow = workflow({ name: 'explode' }).execute(async function* () {
    throw new Error('workflow exploded');
  });
  engine.register(explodeWorkflow);

  return engine;
}

describe('tenant resource quotas', () => {
  const disposables: Engine[] = [];

  afterEach(() => {
    for (const engine of disposables.splice(0)) {
      engine[Symbol.dispose]();
    }
  });

  it('rejects starts that exceed maxConcurrentWorkflows for the same tenant', async () => {
    const engine = createEngine({ quotas: { maxConcurrentWorkflows: 1 } });
    disposables.push(engine);

    const firstHandle = await engine.start('hold', { tenantId: 'acme' });

    const error = await engine.start('hold', { tenantId: 'acme' }).catch((value: unknown) => value);

    expect(error).toBeInstanceOf(QuotaExceededError);
    expect(error).toMatchObject({
      tenantId: 'acme',
      quota: 'maxConcurrentWorkflows',
      currentUsage: 2,
      limit: 1,
      windowMilliseconds: null,
    } satisfies Partial<QuotaExceededError>);

    await engine.signal(firstHandle.id, 'release');
    await firstHandle.result();
  });

  it('checks concurrent workflow quotas atomically across admissions that share storage', async () => {
    const storage = new BarrierConditionalBatchMemoryStorage([KEYS.quotaActive('acme')]);
    const firstWorkflowState = encode({
      id: 'quota-active-1',
      status: 'pending',
      tenant: { id: 'acme' },
    });
    const secondWorkflowState = encode({
      id: 'quota-active-2',
      status: 'pending',
      tenant: { id: 'acme' },
    });
    const firstQuotaManager = new TenantQuotaManager(storage, Date.now, {
      maxConcurrentWorkflows: 1,
    });
    const secondQuotaManager = new TenantQuotaManager(storage, Date.now, {
      maxConcurrentWorkflows: 1,
    });

    const results = await Promise.allSettled([
      firstQuotaManager.commitStartAdmission({
        tenantId: 'acme',
        workflowId: 'quota-active-1',
        startOperations: [
          {
            type: 'put',
            key: KEYS.workflow('quota-active-1'),
            value: firstWorkflowState,
          },
        ],
        estimatedStorageBytes: 0,
      }),
      secondQuotaManager.commitStartAdmission({
        tenantId: 'acme',
        workflowId: 'quota-active-2',
        startOperations: [
          {
            type: 'put',
            key: KEYS.workflow('quota-active-2'),
            value: secondWorkflowState,
          },
        ],
        estimatedStorageBytes: 0,
      }),
    ]);

    const fulfilled = results.filter(
      (result): result is PromiseFulfilledResult<void> => result.status === 'fulfilled',
    );
    const rejected = results.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(storage.conditionalBatchCalls).toBe(2);
    expect(storage.failedConditionalBatches).toBe(1);
    expect(rejected[0]!.reason).toMatchObject({
      tenantId: 'acme',
      quota: 'maxConcurrentWorkflows',
      currentUsage: 2,
      limit: 1,
      windowMilliseconds: null,
    } satisfies Partial<QuotaExceededError>);
  });

  it('checks storage byte quotas atomically across admissions that share storage', async () => {
    const storage = new BarrierConditionalBatchMemoryStorage([KEYS.quotaStorage('acme')]);

    const buildStartOperation = (workflowId: string) => {
      const workflowState = encode({
        id: workflowId,
        status: 'pending',
        tenant: { id: 'acme' },
      });
      const workflowKey = KEYS.workflow(workflowId);

      return {
        estimatedStorageBytes: measureStoredRecordBytes(workflowKey, workflowState),
        operations: [
          {
            type: 'put' as const,
            key: workflowKey,
            value: workflowState,
          },
        ],
      };
    };

    const firstStart = buildStartOperation('quota-storage-1');
    const secondStart = buildStartOperation('quota-storage-2');
    const limit = Math.max(firstStart.estimatedStorageBytes, secondStart.estimatedStorageBytes);

    const firstLimitedManager = new TenantQuotaManager(storage, Date.now, {
      maxStorageBytes: limit,
    });
    const secondLimitedManager = new TenantQuotaManager(storage, Date.now, {
      maxStorageBytes: limit,
    });

    const results = await Promise.allSettled([
      firstLimitedManager.commitStartAdmission({
        tenantId: 'acme',
        workflowId: 'quota-storage-1',
        startOperations: firstStart.operations,
        estimatedStorageBytes: firstStart.estimatedStorageBytes,
      }),
      secondLimitedManager.commitStartAdmission({
        tenantId: 'acme',
        workflowId: 'quota-storage-2',
        startOperations: secondStart.operations,
        estimatedStorageBytes: secondStart.estimatedStorageBytes,
      }),
    ]);

    const fulfilled = results.filter(
      (result): result is PromiseFulfilledResult<void> => result.status === 'fulfilled',
    );
    const rejected = results.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(storage.conditionalBatchCalls).toBe(2);
    expect(storage.failedConditionalBatches).toBe(1);
    const firstWorkflowBytes = encode({
      id: 'quota-storage-1',
      status: 'pending',
      tenant: { id: 'acme' },
    });
    const secondWorkflowBytes = encode({
      id: 'quota-storage-2',
      status: 'pending',
      tenant: { id: 'acme' },
    });
    expect(rejected[0]!.reason).toMatchObject({
      tenantId: 'acme',
      quota: 'maxStorageBytes',
      currentUsage:
        measureStoredRecordBytes(KEYS.workflow('quota-storage-1'), firstWorkflowBytes) +
        measureStoredRecordBytes(KEYS.workflow('quota-storage-2'), secondWorkflowBytes),
      limit,
      windowMilliseconds: null,
    } satisfies Partial<QuotaExceededError>);
  });

  it('does not read estimated storage bytes when storage quotas are disabled', async () => {
    const storage = new MemoryStorage();
    const workflowId = 'quota-no-storage-estimate';
    const workflowState = encode({
      id: workflowId,
      status: 'pending',
      tenant: { id: 'acme' },
    });
    const quotaManager = new TenantQuotaManager(storage, Date.now, {
      maxConcurrentWorkflows: 2,
    });
    let estimateReadCount = 0;

    await quotaManager.commitStartAdmission({
      tenantId: 'acme',
      workflowId,
      startOperations: [
        {
          type: 'put',
          key: KEYS.workflow(workflowId),
          value: workflowState,
        },
      ],
      get estimatedStorageBytes() {
        estimateReadCount++;
        return measureStoredRecordBytes(KEYS.workflow(workflowId), workflowState);
      },
    });

    expect(estimateReadCount).toBe(0);
  });

  it('uses the stored quota storage counter without rescanning workflow state on admission', async () => {
    const storage = new WorkflowScanTrackingStorage();
    const workflowId = 'quota-storage-counter';
    const workflowState = encode({
      id: workflowId,
      status: 'pending',
      tenant: { id: 'acme' },
    });
    const estimatedStorageBytes = measureStoredRecordBytes(
      KEYS.workflow(workflowId),
      workflowState,
    );
    const initialStorageBytes = 128;

    await storage.put(
      KEYS.quotaStorage('acme'),
      encode({ bytes: initialStorageBytes } satisfies { bytes: number }),
    );

    const quotaManager = new TenantQuotaManager(storage, Date.now, {
      maxStorageBytes: initialStorageBytes + estimatedStorageBytes + 1,
    });

    await quotaManager.commitStartAdmission({
      tenantId: 'acme',
      workflowId,
      startOperations: [
        {
          type: 'put',
          key: KEYS.workflow(workflowId),
          value: workflowState,
        },
      ],
      estimatedStorageBytes,
    });

    expect(storage.workflowScanCount).toBe(0);
    expect(decode((await storage.get(KEYS.quotaStorage('acme'))) as Uint8Array)).toEqual({
      bytes: initialStorageBytes + estimatedStorageBytes,
    });
  });

  it('uses the stored active workflow counter without rescanning workflow state on admission', async () => {
    const storage = new WorkflowScanTrackingStorage();
    const workflowId = 'quota-active-counter';
    const workflowState = encode({
      id: workflowId,
      status: 'pending',
      tenant: { id: 'acme' },
    });

    await storage.put(
      KEYS.quotaActive('acme'),
      encode({ workflowIds: ['existing-active'] } satisfies { workflowIds: string[] }),
    );

    const quotaManager = new TenantQuotaManager(storage, Date.now, {
      maxConcurrentWorkflows: 2,
    });

    await quotaManager.commitStartAdmission({
      tenantId: 'acme',
      workflowId,
      startOperations: [
        {
          type: 'put',
          key: KEYS.workflow(workflowId),
          value: workflowState,
        },
      ],
      estimatedStorageBytes: 0,
    });

    expect(storage.workflowScanCount).toBe(0);
    expect(decode((await storage.get(KEYS.quotaActive('acme'))) as Uint8Array)).toEqual({
      workflowIds: ['existing-active', workflowId],
    });
  });

  it('uses the stored active workflow counter without rescanning workflow state on terminal transition', async () => {
    const storage = new WorkflowScanTrackingStorage();

    await storage.put(
      KEYS.quotaActive('acme'),
      encode({
        workflowIds: ['existing-active', 'quota-active-terminal'],
      } satisfies { workflowIds: string[] }),
    );

    const quotaManager = new TenantQuotaManager(storage, Date.now, {
      maxConcurrentWorkflows: 2,
    });

    await quotaManager.commitTerminalTransition({
      tenantId: 'acme',
      workflowId: 'quota-active-terminal',
      operations: [],
    });

    expect(storage.workflowScanCount).toBe(0);
    expect(decode((await storage.get(KEYS.quotaActive('acme'))) as Uint8Array)).toEqual({
      workflowIds: ['existing-active'],
    });
  });

  it('releases storage byte reservations when a tenant workflow reaches a terminal state', async () => {
    const storage = new MemoryStorage();
    const quotaManager = new TenantQuotaManager(storage, Date.now, {
      maxStorageBytes: 1024,
    });

    await storage.put(
      KEYS.quotaStorage('acme'),
      encode({ bytes: 256 } satisfies { bytes: number }),
    );
    await storage.put(
      KEYS.quotaWorkflowStorage('acme', 'wf-storage-release'),
      encode({ bytes: 256 } satisfies { bytes: number }),
    );

    await quotaManager.commitTerminalTransition({
      tenantId: 'acme',
      workflowId: 'wf-storage-release',
      operations: [],
    });

    expect(await storage.get(KEYS.quotaStorage('acme'))).toBeNull();
    expect(await storage.get(KEYS.quotaWorkflowStorage('acme', 'wf-storage-release'))).toBeNull();
  });

  it('falls back to measured workflow storage when a legacy storage reservation is missing', async () => {
    const storage = new MemoryStorage();
    const quotaManager = new TenantQuotaManager(storage, Date.now, {
      maxStorageBytes: 1024,
    });
    const workflowId = 'wf-legacy-storage-release';
    const workflowState = encode({
      id: workflowId,
      status: 'running',
      tenant: { id: 'acme' },
    });
    const workflowBytes = measureStoredRecordBytes(KEYS.workflow(workflowId), workflowState);

    await storage.put(KEYS.workflow(workflowId), workflowState);
    await storage.put(
      KEYS.quotaStorage('acme'),
      encode({ bytes: workflowBytes } satisfies { bytes: number }),
    );

    await quotaManager.commitTerminalTransition({
      tenantId: 'acme',
      workflowId,
      operations: [{ type: 'delete', key: KEYS.workflow(workflowId) }],
    });

    expect(await storage.get(KEYS.quotaStorage('acme'))).toBeNull();
  });

  it('releases active workflow quota when a tenant workflow reaches a terminal state', async () => {
    const engine = createEngine({ quotas: { maxConcurrentWorkflows: 1 } });
    disposables.push(engine);

    const firstHandle = await engine.start('hold', { tenantId: 'acme' });

    await engine.signal(firstHandle.id, 'release');
    await firstHandle.result();

    const secondHandle = await engine.start('hold', { tenantId: 'acme' });
    const usage = await engine.getQuotaUsage('acme');

    expect(usage.activeWorkflows.used).toBe(1);
    expect(usage.activeWorkflows.limit).toBe(1);

    await engine.signal(secondHandle.id, 'release');
    await secondHandle.result();
  });

  it('releases active workflow quota when a tenant workflow fails', async () => {
    const engine = createEngine({ quotas: { maxConcurrentWorkflows: 1 } });
    disposables.push(engine);

    const failedHandle = await engine.start('explode', { tenantId: 'acme' });
    await expect(failedHandle.result()).rejects.toThrow('workflow exploded');

    const secondHandle = await engine.start('hold', { tenantId: 'acme' });
    await engine.signal(secondHandle.id, 'release');
    await expect(secondHandle.result()).resolves.toBeDefined();
  });

  it('releases active workflow quota when a tenant workflow is cancelled', async () => {
    const engine = createEngine({ quotas: { maxConcurrentWorkflows: 1 } });
    disposables.push(engine);

    const cancelledHandle = await engine.start('hold', { tenantId: 'acme' });
    await engine.cancel(cancelledHandle.id);
    await expect(cancelledHandle.result()).rejects.toThrow('cancelled');

    const secondHandle = await engine.start('hold', { tenantId: 'acme' });
    await engine.signal(secondHandle.id, 'release');
    await expect(secondHandle.result()).resolves.toBeDefined();
  });

  it('serializes cancellation before a concurrent tenant workflow completion writes terminal state', async () => {
    const workflowId = 'quota-terminal-write-serialization';
    const storage = new TerminalTransitionBarrierStorage(workflowId);
    const engine = createEngine({
      storage,
      quotas: { maxConcurrentWorkflows: 4 },
    });
    disposables.push(engine);

    const activityStarted = Promise.withResolvers<void>();
    const activityResult = Promise.withResolvers<string>();

    const slowTenantCompletionWorkflow = workflow({ name: 'slow-tenant-completion' }).execute(
      async function* (context: WorkflowContext) {
        const result = yield* context.run(async () => {
          activityStarted.resolve();
          return activityResult.promise;
        });
        return result;
      },
    );
    engine.register(slowTenantCompletionWorkflow);

    const handle = await engine.start(
      'slow-tenant-completion',
      { tenantId: 'acme' },
      { id: workflowId },
    );
    await activityStarted.promise;

    storage.arm();

    const cancelPromise = engine.cancel(handle.id);
    await storage.waitForBlockedTransitionWrite();

    activityResult.resolve('completed');
    await Promise.resolve();

    expect(storage.sawConcurrentWorkflowRead).toBe(false);

    storage.releaseBlockedTransitionWrite();

    await cancelPromise;
    await expect(handle.result()).rejects.toThrow('Workflow cancelled');
    await expect(engine.get(workflowId)).resolves.toMatchObject({ status: 'cancelled' });
  });

  it('rejects starts that exceed maxWorkflowCreationRate within the configured window', async () => {
    let now = new Date('2026-04-19T07:00:00.000Z').getTime();
    const engine = createEngine({
      now: () => now,
      quotas: {
        maxWorkflowCreationRate: { count: 1, window: '1m' },
      },
    });
    disposables.push(engine);

    await engine.start('echo', { tenantId: 'acme', value: 1 });

    const error = await engine
      .start('echo', { tenantId: 'acme', value: 2 })
      .catch((value) => value);

    expect(error).toBeInstanceOf(QuotaExceededError);
    expect(error).toMatchObject({
      tenantId: 'acme',
      quota: 'maxWorkflowCreationRate',
      currentUsage: 2,
      limit: 1,
      windowMilliseconds: 60_000,
    } satisfies Partial<QuotaExceededError>);

    now += 61_000;

    await expect(engine.start('echo', { tenantId: 'acme', value: 3 })).resolves.toBeDefined();
  });

  it('captures the workflow creation timestamp once per admission attempt', async () => {
    const storage = new MemoryStorage();
    let nowCalls = 0;
    const quotaManager = new TenantQuotaManager(
      storage,
      () => {
        nowCalls++;
        return 1000 + nowCalls;
      },
      {
        maxWorkflowCreationRate: { count: 2, window: '1m' },
      },
    );
    const workflowId = 'quota-rate-single-now';
    const workflowState = encode({
      id: workflowId,
      status: 'pending',
      tenant: { id: 'acme' },
    });

    await quotaManager.commitStartAdmission({
      tenantId: 'acme',
      workflowId,
      startOperations: [
        {
          type: 'put',
          key: KEYS.workflow(workflowId),
          value: workflowState,
        },
      ],
      estimatedStorageBytes: 0,
    });

    expect(nowCalls).toBe(1);
    expect(decode((await storage.get(KEYS.quotaRate('acme', 60_000))) as Uint8Array)).toMatchObject(
      {
        timestamps: [1001],
      },
    );
  });

  it('rejects starts that would exceed maxStorageBytes for a tenant', async () => {
    const engine = createEngine({ quotas: { maxStorageBytes: 512 } });
    disposables.push(engine);

    const error = await engine
      .start('echo', {
        tenantId: 'acme',
        payload: 'x'.repeat(4_096),
      })
      .catch((value) => value);

    expect(error).toBeInstanceOf(QuotaExceededError);
    expect(error).toMatchObject({
      tenantId: 'acme',
      quota: 'maxStorageBytes',
      limit: 512,
      windowMilliseconds: null,
    } satisfies Partial<QuotaExceededError>);
    expect((error as QuotaExceededError).currentUsage).toBeGreaterThan(512);
  });

  it('counts attribute, tag, and timer records in start-time storage byte estimates', async () => {
    const storage = new MemoryStorage();
    const workflowId = 'quota-storage-estimate';
    const workflowState = encode({
      id: workflowId,
      status: 'pending',
      tenant: { id: 'acme' },
    });
    const timerOperations = buildTimerBatchOperations({
      id: `deadline:${workflowId}`,
      workflowId,
      fireAt: 5_000,
      kind: 'execution-deadline',
    });
    const startOperations: BatchOperation[] = [
      {
        type: 'put',
        key: KEYS.workflow(workflowId),
        value: workflowState,
      },
      {
        type: 'put',
        key: KEYS.attributeIndex('status', 's:queued', workflowId),
        value: new Uint8Array(0),
      },
      {
        type: 'put',
        key: KEYS.tagIndex('nightly', workflowId),
        value: new Uint8Array(0),
      },
      ...timerOperations,
    ];
    const expectedStorageBytes = startOperations.reduce((total, operation) => {
      if (operation.type !== 'put') {
        return total;
      }

      return total + measureStoredRecordBytes(operation.key, operation.value);
    }, 0);
    const quotaManager = new TenantQuotaManager(storage, Date.now, {
      maxStorageBytes: expectedStorageBytes - 1,
    });

    const error = await quotaManager
      .commitStartAdmission({
        tenantId: 'acme',
        workflowId,
        startOperations,
        estimatedStorageBytes: quotaManager.estimateStartStorageBytes(workflowId, startOperations),
      })
      .catch((value: unknown) => value);

    expect(error).toBeInstanceOf(QuotaExceededError);
    expect(error).toMatchObject({
      tenantId: 'acme',
      quota: 'maxStorageBytes',
      currentUsage: expectedStorageBytes,
      limit: expectedStorageBytes - 1,
      windowMilliseconds: null,
    } satisfies Partial<QuotaExceededError>);
  });

  it('ignores malformed durable quota records instead of failing quota reads', async () => {
    const storage = new MemoryStorage();
    const engine = createEngine({
      storage,
      quotas: {
        maxConcurrentWorkflows: 2,
        maxWorkflowCreationRate: { count: 2, window: '1m' },
      },
    });
    disposables.push(engine);

    await storage.put('wf:corrupt', new Uint8Array([0xc1]));
    await storage.put(KEYS.quotaRate('acme', 60_000), new Uint8Array([0xc1]));

    const usage = await engine.getQuotaUsage('acme');

    expect(usage.activeWorkflows.used).toBe(0);
    expect(usage.workflowCreationRate.used).toBe(0);
    await expect(engine.start('echo', { tenantId: 'acme', value: 1 })).resolves.toBeDefined();
  });

  it('counts attribute, tag, and timer records in tenant quota usage', async () => {
    const storage = new MemoryStorage();
    const quotaManager = new TenantQuotaManager(storage, Date.now, {
      maxStorageBytes: 65_536,
    });
    const workflowId = 'quota-usage-records';
    const workflowState = encode({
      id: workflowId,
      status: 'running',
      tenant: { id: 'acme' },
    });
    const indexValue = new Uint8Array(0);
    const timerOperations = buildTimerBatchOperations({
      id: `review-timeout:${workflowId}`,
      workflowId,
      fireAt: 15_000,
      kind: 'sleep',
    });

    await storage.put(KEYS.workflow(workflowId), workflowState);
    await storage.put(KEYS.attribute(workflowId), encode({ status: 'queued' }));
    await storage.put(KEYS.attributeIndex('status', 's:queued', workflowId), indexValue);
    await storage.put(KEYS.tagIndex('nightly', workflowId), indexValue);
    for (const operation of timerOperations) {
      if (operation.type === 'put') {
        await storage.put(operation.key, operation.value);
      }
    }

    const usage = await quotaManager.getUsage('acme');
    const expectedStorageBytes =
      measureStoredRecordBytes(KEYS.workflow(workflowId), workflowState) +
      measureStoredRecordBytes(KEYS.attribute(workflowId), encode({ status: 'queued' })) +
      measureStoredRecordBytes(KEYS.attributeIndex('status', 's:queued', workflowId), indexValue) +
      measureStoredRecordBytes(KEYS.tagIndex('nightly', workflowId), indexValue) +
      timerOperations.reduce((total, operation) => {
        if (operation.type !== 'put') {
          return total;
        }

        return total + measureStoredRecordBytes(operation.key, operation.value);
      }, 0);

    expect(usage.storageBytes.used).toBe(expectedStorageBytes);
  });

  it('counts nested workflow state records without rescanning the full workflow prefix', async () => {
    const storage = new WorkflowScanTrackingStorage();
    const quotaManager = new TenantQuotaManager(storage, Date.now, {
      maxStorageBytes: 65_536,
    });
    const workflowId = 'quota-usage-checkpoint-prefix';
    const workflowState = encode({
      id: workflowId,
      status: 'running',
      tenant: { id: 'acme' },
    });
    const checkpoint = encode({ step: 3, result: 'checkpointed' });

    await storage.put(KEYS.workflow(workflowId), workflowState);
    await storage.put(KEYS.checkpoint(workflowId), checkpoint);

    const usage = await quotaManager.getUsage('acme');

    expect(usage.storageBytes.used).toBe(
      measureStoredRecordBytes(KEYS.workflow(workflowId), workflowState) +
        measureStoredRecordBytes(KEYS.checkpoint(workflowId), checkpoint),
    );
    expect(storage.workflowScanCount).toBe(1);
    expect(storage.nestedWorkflowPrefixes).toEqual([`${KEYS.workflow(workflowId)}:`]);
  });

  it('counts workflow ids that begin with "ckpt" in tenant quota usage and active workflow scans', async () => {
    const engine = createEngine({
      storage: new MemoryStorage(),
      quotas: {
        maxConcurrentWorkflows: 1,
        maxStorageBytes: 65_536,
      },
    });
    disposables.push(engine);

    const handle = await engine.start('hold', { tenantId: 'acme' }, { id: 'ckpt-starts-counted' });
    const usage = await engine.getQuotaUsage('acme');

    expect(usage.activeWorkflows.used).toBe(1);
    expect(usage.storageBytes.used).toBeGreaterThan(0);

    await engine.signal(handle.id, 'release');
    await expect(handle.result()).resolves.toBe('released');
  });

  it('reports current quota usage versus configured limits for a tenant', async () => {
    let now = new Date('2026-04-19T07:00:00.000Z').getTime();
    const engine = createEngine({
      now: () => now,
      quotas: {
        maxConcurrentWorkflows: 2,
        maxStorageBytes: 32_768,
        maxWorkflowCreationRate: { count: 3, window: '5m' },
      },
    });
    disposables.push(engine);

    const handle = await engine.start('hold', {
      tenantId: 'acme',
      payload: 'quota-visible',
    });

    const usage = await engine.getQuotaUsage('acme');

    expect(usage.tenantId).toBe('acme');
    expect(usage.activeWorkflows.used).toBe(1);
    expect(usage.activeWorkflows.limit).toBe(2);
    expect(usage.storageBytes.used).toBeGreaterThan(0);
    expect(usage.storageBytes.limit).toBe(32_768);
    expect(usage.workflowCreationRate.used).toBe(1);
    expect(usage.workflowCreationRate.limit).toBe(3);
    expect(usage.workflowCreationRate.windowMilliseconds).toBe(300_000);

    now += 1_000;
    await engine.signal(handle.id, 'release');
    await handle.result();
  });

  it('does not apply per-tenant quotas when the workflow has no tenant context', async () => {
    const engine = createEngine({ quotas: { maxConcurrentWorkflows: 1 } });
    disposables.push(engine);

    const firstHandle = await engine.start('hold', {});
    const secondHandle = await engine.start('hold', {});

    await engine.signal(firstHandle.id, 'release');
    await engine.signal(secondHandle.id, 'release');
    await Promise.all([firstHandle.result(), secondHandle.result()]);
  });

  it('requires conditionalBatch support for storage byte quotas', () => {
    const memoryStorage = new MemoryStorage();
    const storageWithoutConditionalBatch: WeftStorage = {
      // Honestly reports conditionalBatch: false even though the bound
      // MemoryStorage method exists — proves the quota gate trusts the
      // capability report, not method presence.
      capabilities: () => ({
        readAfterWrite: 'linearizable',
        scanConsistency: 'snapshot',
        atomicBatch: true,
        conditionalBatch: false,
        boundedRangeDelete: false,
      }),
      get: memoryStorage.get.bind(memoryStorage),
      put: memoryStorage.put.bind(memoryStorage),
      delete: memoryStorage.delete.bind(memoryStorage),
      scan: memoryStorage.scan.bind(memoryStorage),
      batch: memoryStorage.batch.bind(memoryStorage),
      [Symbol.dispose]: memoryStorage[Symbol.dispose].bind(memoryStorage),
    };

    expect(
      () =>
        new TenantQuotaManager(storageWithoutConditionalBatch, Date.now, { maxStorageBytes: 1 }),
    ).toThrow(
      'EngineOptions.quotas.maxConcurrentWorkflows, maxWorkflowCreationRate, and maxStorageBytes require a storage backend whose capabilities() reports conditionalBatch support.',
    );
  });
});
