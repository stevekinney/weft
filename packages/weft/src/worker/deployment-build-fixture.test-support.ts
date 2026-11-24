/**
 * Shared fixtures for the tests that drive real engine runs against a deployment catalog
 * (COR-1582): an engine whose `checkout` runs wait for a `go` signal, a catalog with two ready
 * builds, and a storage that lets a test run its own work just before one of a batch commit.
 */
import { expect } from 'bun:test';

import type { OperationFault } from "../embedded/backchannel/src/index.ts";
import { MemoryStorage } from "../embedded/storage/src/index.ts";
import { decode } from '../core/codec/index.ts';
import { Engine } from '../core/engine.ts';
import { type WorkflowState, workflow } from '../core/types.ts';
import { bindingStampShard } from './deployment-records.ts';
import { WorkerDeploymentCatalog } from './deployment-routing.ts';
import type { WorkerManifest } from './manifest/types.ts';

export const DEPLOYMENT = 'test-deployment';

export function buildManifest(
  revision: string,
  buildId: string,
  workflowType = 'checkout',
): WorkerManifest {
  return {
    manifestVersion: 1,
    protocolVersion: 1,
    sdkVersion: 'test',
    runtime: { name: 'bun', version: 'test' },
    deployment: { name: DEPLOYMENT, buildId, artifactDigest: `sha256:${buildId}` },
    workflows: {
      [workflowType]: {
        workflowVersion: '0.0.0',
        workflowRevision: revision,
        contractHash: 'sha256:workflow',
        activities: { charge: { contractHash: 'sha256:charge', implementationRevision: buildId } },
      },
    },
    capabilities: {},
  };
}

export type Invocable = { invoke: (context: never) => Promise<unknown> };

export function invoke(operation: Invocable, input: unknown, host?: unknown): Promise<unknown> {
  return operation.invoke({ input, host } as never);
}

export async function faultOf(promise: Promise<unknown>): Promise<OperationFault> {
  try {
    await promise;
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && 'data' in error) {
      return error as OperationFault;
    }
    throw new Error(`Expected an OperationFault, received ${String(error)}`, { cause: error });
  }
  throw new Error('Expected the operation to fault, but it succeeded.');
}

/** An engine whose `checkout` runs wait for a `go` signal, over a catalog with two ready builds. */
export async function fixture(
  storage: MemoryStorage = new InterleavingStorage(),
  seedCatalog = true,
) {
  const engine = new Engine({ storage });
  engine.register(
    workflow({ name: 'checkout', workerVersioningPolicy: { mode: 'pinned' } }).execute(
      async function* (ctx) {
        return yield* ctx.waitForSignal<string>('go');
      },
    ),
  );
  const [firstRevision] = await engine.workflows.listRevisions('checkout');
  const revision = firstRevision?.manifest.revision ?? '';
  const catalog = new WorkerDeploymentCatalog(storage);
  const disposable = {
    storage,
    engine,
    catalog,
    revision,
    async [Symbol.asyncDispose]() {
      engine[Symbol.dispose]();
    },
  };
  if (!seedCatalog) return disposable;
  for (const buildId of ['build-1', 'build-2']) {
    await catalog.registerVersion({
      deploymentName: DEPLOYMENT,
      buildId,
      artifactDigest: `sha256:${buildId}`,
      manifestDigest: `sha256:manifest-${buildId}`,
      manifest: buildManifest(revision, buildId),
      state: 'ready',
      firstSeenAt: 1,
    });
  }
  await catalog.setRouting({
    deploymentName: DEPLOYMENT,
    currentBuildId: 'build-1',
    rampBasisPoints: 10_000,
    updatedAt: 1,
  });
  return disposable;
}

/** Route new work off `build-1` and drain it, so only the work already on it keeps it alive. */
export async function drainBuildOne(catalog: WorkerDeploymentCatalog): Promise<void> {
  await catalog.setRouting({
    deploymentName: DEPLOYMENT,
    currentBuildId: 'build-2',
    rampBasisPoints: 10_000,
    updatedAt: 2,
    expectedGeneration: 1,
  });
  await catalog.setVersionState(DEPLOYMENT, 'build-1', 'draining');
}

export const REMOVE_BUILD_ONE = { deploymentName: DEPLOYMENT, buildId: 'build-1' };

type BatchOperations = Parameters<MemoryStorage['conditionalBatch']>[1];

/** Whether a batch writes the version record of some build in the given state (`removed`, say). */
export function writesVersionState(operations: BatchOperations, state: string): boolean {
  return operations.some(
    (operation) =>
      operation.type === 'put' &&
      operation.key.startsWith('worker-deployment-version:') &&
      (decode(operation.value) as { state?: string }).state === state,
  );
}

/** Whether a batch puts a key that starts with `prefix`. */
export function putsKeyWithPrefix(operations: BatchOperations, prefix: string): boolean {
  return operations.some(
    (operation) => operation.type === 'put' && operation.key.startsWith(prefix),
  );
}

/** The stamp shard key of a build, spelled out so a test does not share the code under test. */
export const stampKeyOf = (buildId: string, shard = 0, deploymentName = DEPLOYMENT) =>
  `worker-deployment-binding:${encodeURIComponent(deploymentName)}:${encodeURIComponent(buildId)}:${shard.toString(16).padStart(2, '0')}`;
/** The shard a binding with this key (a run id, or a ledger operation id) must stamp. */
export const ownShardOf = (bindingKey: string) => bindingStampShard(bindingKey);
/** The stamp key a binding with this key must put for the build. */
export const ownStampKeyOf = (buildId: string, bindingKey: string, deploymentName = DEPLOYMENT) =>
  stampKeyOf(buildId, ownShardOf(bindingKey), deploymentName);
export const tombstoneKeyOf = (buildId: string, deploymentName = DEPLOYMENT) =>
  `worker-deployment-removed:${encodeURIComponent(deploymentName)}:${encodeURIComponent(buildId)}`;

type BatchCondition = Parameters<MemoryStorage['conditionalBatch']>[0][number];

/** The build a stored record binds work to and the record's own binding key, or `undefined` when it binds none. */
function boundBuildOfRecord(key: string, bytes: Uint8Array): [string, string, string] | undefined {
  const record = decode(bytes) as {
    id?: string;
    operationId?: string;
    status?: string;
    state?: string;
    workerBinding?: { current?: { deploymentName?: string; buildId?: string } };
    executionRequirement?: { deploymentName?: string; buildId?: string };
  };
  const named = key.startsWith('task-ledger:')
    ? record.executionRequirement
    : record.workerBinding?.current;
  return typeof named?.deploymentName === 'string' && typeof named.buildId === 'string'
    ? [named.deploymentName, named.buildId, (record.operationId ?? record.id) as string]
    : undefined;
}

/**
 * The class guard (COR-1582): a committed batch that binds durable work to a build must also put
 * that build's binding stamp and condition on that build's tombstone being absent. A batch binds
 * work when it puts a top-level `wf:` record whose `workerBinding.current` names a build that the
 * stored record did not already carry as a live run (a create, a restart or retry of a terminal
 * run, or a move to another build), or a `task-ledger:` entry whose requirement names a build and
 * that did not exist. The check throws, so a binding path added without both fails the test that
 * first exercises it.
 */
async function assertBindingCommitsAreStamped(
  storage: MemoryStorage,
  conditions: readonly BatchCondition[],
  operations: BatchOperations,
): Promise<void> {
  const terminal = new Set(['completed', 'failed', 'cancelled', 'timed-out']);
  for (const operation of operations) {
    const topLevelRun =
      operation.type === 'put' &&
      operation.key.startsWith('wf:') &&
      !operation.key.slice(3).includes(':');
    const ledger = operation.type === 'put' && operation.key.startsWith('task-ledger:');
    if (operation.type !== 'put' || !(topLevelRun || ledger)) continue;
    const bound = boundBuildOfRecord(operation.key, operation.value);
    if (bound === undefined) continue;
    const previousBytes = await storage.get(operation.key);
    const previous =
      previousBytes === null ? undefined : boundBuildOfRecord(operation.key, previousBytes);
    const previousState =
      previousBytes === null
        ? undefined
        : (decode(previousBytes) as { status?: string; state?: string });
    const alreadyLive =
      previous !== undefined &&
      previous[0] === bound[0] &&
      previous[1] === bound[1] &&
      !terminal.has(previousState?.status ?? '') &&
      previousState?.state !== 'terminal';
    if (alreadyLive) continue;
    const ownStamp = ownStampKeyOf(bound[1], bound[2], bound[0]);
    const shardPuts = operations.filter(
      (candidate) =>
        candidate.type === 'put' &&
        candidate.key.startsWith(stampKeyOf(bound[1], 0, bound[0]).slice(0, -2)),
    );
    if (shardPuts.some((candidate) => candidate.key !== ownStamp)) {
      throw new Error(
        `Binding commit for ${operation.key} puts a stamp shard of ${bound[0]}/${bound[1]} that is not its own.`,
      );
    }
    const stamped = shardPuts.length > 0;
    const guarded = conditions.some(
      (condition) =>
        condition.key === tombstoneKeyOf(bound[1], bound[0]) && condition.expectedValue === null,
    );
    if (!stamped || !guarded) {
      throw new Error(
        `Binding commit for ${operation.key} to ${bound[0]}/${bound[1]} lacks ${stamped ? '' : "the build's stamp put"}${stamped || guarded ? '' : ' and '}${guarded ? '' : 'the tombstone-absent condition'}.`,
      );
    }
  }
}

/**
 * A storage that runs a test's own work just before a chosen `conditionalBatch` commits: the next
 * one, or the first whose operations satisfy `when`. The work runs once, and `fired` says whether
 * it did, so a test can tell a batch that never came from one that came and passed. It can also
 * run work just before the next `scan` of a prefix, and it applies the class guard to every batch
 * it commits (turn it off with `guardBindings = false` for a test that writes records on purpose).
 */
export class InterleavingStorage extends MemoryStorage {
  #beforeCommit: (() => Promise<void>) | undefined;
  #when: ((operations: BatchOperations) => boolean) | undefined;
  #beforeScan: { prefix: string; work: () => Promise<void> } | undefined;
  #afterGet: { key: string; work: () => Promise<void> } | undefined;
  fired: boolean;
  guardBindings: boolean;
  /** The key of every put a committed batch carried, in order. */
  readonly committedPuts: string[];
  // Assigned here, not by field initializers: Bun reports a class's synthetic initializer
  // function as never called, which fails the coverage gate's function count.
  constructor() {
    super();
    this.fired = false;
    this.guardBindings = true;
    this.committedPuts = [];
  }
  arm(beforeCommit: () => Promise<void>, when?: (operations: BatchOperations) => boolean): void {
    this.#beforeCommit = beforeCommit;
    this.#when = when;
    this.fired = false;
  }
  /** Run `work` once, just before the next scan of `prefix` begins. */
  armScan(prefix: string, work: () => Promise<void>): void {
    this.#beforeScan = { prefix, work };
    this.fired = false;
  }
  /** Run `work` once, right after the next read of `key` returns, before its reader sees the value. */
  armGet(key: string, work: () => Promise<void>): void {
    this.#afterGet = { key, work };
    this.fired = false;
  }
  override async get(key: string) {
    const value = await super.get(key);
    const armed = this.#afterGet;
    if (armed !== undefined && armed.key === key) {
      this.#afterGet = undefined;
      this.fired = true;
      await armed.work();
    }
    return value;
  }
  override async *scan(...args: Parameters<MemoryStorage['scan']>) {
    const armed = this.#beforeScan;
    if (armed !== undefined && args[0].startsWith(armed.prefix)) {
      this.#beforeScan = undefined;
      this.fired = true;
      await armed.work();
    }
    yield* super.scan(...args);
  }
  override async conditionalBatch(...args: Parameters<MemoryStorage['conditionalBatch']>) {
    const beforeCommit = this.#beforeCommit;
    if (beforeCommit !== undefined && (this.#when?.(args[1]) ?? true)) {
      this.#beforeCommit = undefined;
      this.fired = true;
      await beforeCommit();
    }
    if (this.guardBindings) await assertBindingCommitsAreStamped(this, args[0], args[1]);
    const committed = await super.conditionalBatch(...args);
    if (committed) {
      for (const operation of args[1]) {
        if (operation.type === 'put') this.committedPuts.push(operation.key);
      }
    }
    return committed;
  }
  override async batch(...args: Parameters<MemoryStorage['batch']>) {
    if (this.guardBindings) await assertBindingCommitsAreStamped(this, [], args[0]);
    return super.batch(...args);
  }
}

/** The status and bound build a run record holds, read straight from storage. */
export async function runOf(storage: MemoryStorage, id: string) {
  const bytes = await storage.get(`wf:${id}`);
  if (bytes === null) return undefined;
  const state = decode(bytes) as WorkflowState;
  return { status: state.status, buildId: state.workerBinding?.current.buildId };
}

/** The lifecycle state of a build, read from the catalog. */
export async function stateOf(catalog: WorkerDeploymentCatalog, buildId: string) {
  const version = await catalog.getVersion(DEPLOYMENT, buildId);
  return version?.state;
}

/** Every top-level run record, as `[id, status, bound build]`. */
export async function runs(storage: MemoryStorage) {
  const found: Array<[string, string, string | undefined]> = [];
  for await (const [key, bytes] of storage.scan('wf:')) {
    if (key.slice(3).includes(':')) continue;
    const state = decode(bytes) as WorkflowState;
    found.push([state.id, state.status, state.workerBinding?.current.buildId]);
  }
  return found.toSorted(([left], [right]) => left.localeCompare(right));
}

/** The invariant: no run that can still execute is bound to a build that has been removed. */
export async function assertNoRunOnRemovedBuild(
  storage: MemoryStorage,
  catalog: WorkerDeploymentCatalog,
) {
  const terminal = new Set(['completed', 'failed', 'cancelled', 'timed-out']);
  const versions = await catalog.listVersions();
  const removed = versions
    .filter((version) => version.state === 'removed')
    .map((version) => version.buildId);
  const everyRun = await runs(storage);
  const stranded = everyRun.filter(
    ([, status, buildId]) =>
      !terminal.has(status) && buildId !== undefined && removed.includes(buildId),
  );
  expect(stranded).toEqual([]);
}

/** `checkout-1` finished on `build-1`, which is then routed away from and drained. */
export async function finishedRunOnDrainedBuild(storage = new InterleavingStorage()) {
  const fx = await fixture(storage);
  const handle = await fx.engine.start('checkout', null, { id: 'checkout-1' });
  await handle.signal('go', 'done');
  await handle.result();
  await drainBuildOne(fx.catalog);
  return { ...fx, storage };
}
