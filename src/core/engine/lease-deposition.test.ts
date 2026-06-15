/**
 * #470 Step 2: epoch fencing of durable writes. When `ownership: 'lease'` is
 * configured, every engine-generator-owned per-workflow durable write is
 * conditioned on the held lease epoch, so a deposed instance (whose lease was
 * stolen during a GC pause or partition) loses its write instead of corrupting
 * the successor's state. These tests prove the HALT — not merely that one CAS
 * returned false, but that a deposed engine sets its `deposed` flag, warns the
 * operator, tears itself down, and rejects every subsequent fenced write — and
 * that `ownership: 'none'` is a byte-for-byte no-op (plain batch, no epoch
 * condition).
 *
 * BunSQLiteStorage(':memory:') is used because its conditionalBatch is
 * transactionally atomic — MemoryStorage's in-process Map serializes operations
 * and cannot model a deposed write losing a real CAS race.
 */
import { describe, expect, it } from 'bun:test';

import { BunSQLiteStorage } from '../../storage/bun-sql.ts';
import type {
  BatchOperation,
  ConditionalBatchCondition,
  Storage,
} from '../../storage/interface.ts';
import { KEYS } from '../../storage/interface.ts';
import { waitForCondition } from '../../testing/fake-timers.test-support.ts';
import { workflow, type WorkflowContext } from '../types.ts';
import {
  commitFencedEngineWrite,
  commitFencedEngineWriteAllowingPreconditionFailure,
} from './fenced-write.ts';
import { Engine, ENGINE_LEASE_LOST_WARNING_NAME, EngineLeaseNotHeldError } from './index.ts';
import { getInternals } from './internals.ts';

const waiterWorkflow = workflow({ name: 'deposition-waiter' }).execute(async function* (
  ctx: WorkflowContext,
) {
  yield* ctx.waitForSignal('continue');
  return 'resumed';
});

async function readEpoch(storage: Storage): Promise<number | null> {
  const raw = await storage.get(KEYS.leaseEpoch());
  if (raw === null) return null;
  return Number(new DataView(raw.buffer, raw.byteOffset, raw.byteLength).getBigUint64(0, false));
}

async function readHolderId(storage: Storage): Promise<string | undefined> {
  const raw = await storage.get(KEYS.leaseHolder());
  if (raw === null) return undefined;
  const holder: { holderId?: string } = JSON.parse(new TextDecoder().decode(raw));
  return holder.holderId;
}

/**
 * Overwrite the lease keys to simulate a successor stealing the lease and bumping
 * the epoch — the deposition trigger a real GC-paused predecessor would face.
 */
async function stealLease(storage: Storage, newEpoch: number, holderId: string): Promise<void> {
  const epochBytes = new Uint8Array(8);
  new DataView(epochBytes.buffer).setBigUint64(0, BigInt(newEpoch), false);
  const holderBytes = new TextEncoder().encode(
    JSON.stringify({ holderId, expiresAt: 1e15, epoch: newEpoch }),
  );
  await storage.batch([
    { type: 'put', key: KEYS.leaseEpoch(), value: epochBytes },
    { type: 'put', key: KEYS.leaseHolder(), value: holderBytes },
  ]);
}

describe('#470 Step 2: epoch fencing of durable writes', () => {
  it('halts the engine when a fenced checkpoint commit loses its CAS to a newer epoch', async () => {
    const storage = new BunSQLiteStorage(':memory:');
    const engine = await Engine.create({
      storage,
      workflows: { 'deposition-waiter': waiterWorkflow },
      ownership: 'lease',
    });

    const warnings: string[] = [];
    const listener = (warning: Error): void => {
      warnings.push(warning.name);
    };
    process.on('warning', listener);

    try {
      // First commit happens at epoch 1 (held): the workflow parks on the signal.
      const handle = await engine.start('deposition-waiter', null, { id: 'deposed-run' });
      await waitForCondition(
        async () => (await storage.get(KEYS.checkpoint('deposed-run'))) !== null,
        { label: 'first checkpoint at epoch 1' },
      );
      expect(getInternals(engine).deposed).toBe(false);

      // A successor steals the lease (epoch 1 -> 2) while this engine believes it
      // still holds. Signal delivery is not yet fenced (Step 2 wires only the
      // checkpoint commit here), so the signal lands and drives the resume — whose
      // checkpoint commit is the first fenced write to hit the stale epoch.
      await stealLease(storage, 2, 'successor');
      await handle.signal('continue');

      // The deposition handler sets the flag synchronously on CAS failure and
      // schedules a deferred teardown. Wait for the flag (the resume commit must
      // run first), then for the engine to actually tear down.
      await waitForCondition(async () => getInternals(engine).deposed, {
        label: 'engine marked deposed',
      });
      await waitForCondition(async () => getInternals(engine).disposed, {
        label: 'deposed engine torn down',
      });
    } finally {
      process.off('warning', listener);
    }

    // The operator-facing warning fired (the swallowed throw surfaces nothing else).
    expect(warnings).toContain(ENGINE_LEASE_LOST_WARNING_NAME);

    // The successor's lease is intact — the deposed engine's release() CAS-failed
    // (correctly a no-op) and never clobbered the new owner.
    expect(await readEpoch(storage)).toBe(2);
    expect(await readHolderId(storage)).toBe('successor');

    storage[Symbol.dispose]?.();
  });

  it('rejects every subsequent fenced write once deposed (the halt is sticky)', async () => {
    const storage = new BunSQLiteStorage(':memory:');
    const engine = await Engine.create({
      storage,
      workflows: { 'deposition-waiter': waiterWorkflow },
      ownership: 'lease',
    });
    const internals = getInternals(engine);

    // Mark deposed directly (the same state the commit-path detection reaches),
    // then prove the helper short-circuits at its top — a write that STARTS after
    // deposition never touches storage.
    internals.deposed = true;

    let batched = false;
    const probe: Storage = {
      capabilities: () => storage.capabilities(),
      get: (key) => storage.get(key),
      put: (key, value) => storage.put(key, value),
      delete: (key) => storage.delete(key),
      scan: (prefix, options) => storage.scan(prefix, options),
      batch: (operations: BatchOperation[]) => {
        batched = true;
        return storage.batch(operations);
      },
      conditionalBatch: (conditions: ConditionalBatchCondition[], operations: BatchOperation[]) => {
        batched = true;
        return storage.conditionalBatch(conditions, operations);
      },
      [Symbol.dispose]: () => storage[Symbol.dispose](),
    };
    internals.storage = probe;

    await expect(
      commitFencedEngineWrite(
        internals,
        [{ type: 'put', key: 'k', value: new Uint8Array([1]) }],
        [],
        () => new Error('unused'),
      ),
    ).rejects.toThrow(/deposed/i);
    expect(batched).toBe(false);

    internals.storage = storage;
    await engine[Symbol.asyncDispose]();
    storage[Symbol.dispose]?.();
  });

  it('treats a same-epoch CAS failure as an ordinary lost race, not a deposition', async () => {
    const storage = new BunSQLiteStorage(':memory:');
    const engine = await Engine.create({
      storage,
      workflows: { 'deposition-waiter': waiterWorkflow },
      ownership: 'lease',
    });
    const internals = getInternals(engine);

    // A conditionalBatch that fails its BASE condition while the epoch still matches
    // (no successor): the disambiguation re-read sees the held epoch unchanged, so
    // the failure is the caller's lost-race error — existing retry semantics — and
    // the engine is NOT deposed.
    const lostRace = new Error('lost the checkpoint race');
    await expect(
      commitFencedEngineWrite(
        internals,
        [{ type: 'put', key: KEYS.checkpoint('x'), value: new Uint8Array([1]) }],
        // Require-absent on a key we pre-populate, forcing a base-condition failure
        // with the epoch condition still satisfied.
        [{ key: KEYS.leaseHolder(), expectedValue: null }],
        () => lostRace,
      ),
    ).rejects.toBe(lostRace);
    expect(internals.deposed).toBe(false);

    await engine[Symbol.asyncDispose]();
    storage[Symbol.dispose]?.();
  });

  it('is a byte-for-byte no-op under ownership: none (plain batch, no epoch condition)', async () => {
    const storage = new BunSQLiteStorage(':memory:');
    const engine = await Engine.create({
      storage,
      workflows: { 'deposition-waiter': waiterWorkflow },
    });
    const internals = getInternals(engine);

    let plainBatchOps: BatchOperation[] | null = null;
    let conditionalUsed = false;
    const probe: Storage = {
      capabilities: () => storage.capabilities(),
      get: (key) => storage.get(key),
      put: (key, value) => storage.put(key, value),
      delete: (key) => storage.delete(key),
      scan: (prefix, options) => storage.scan(prefix, options),
      batch: (operations: BatchOperation[]) => {
        plainBatchOps = operations;
        return storage.batch(operations);
      },
      conditionalBatch: (conditions: ConditionalBatchCondition[], operations: BatchOperation[]) => {
        conditionalUsed = true;
        return storage.conditionalBatch(conditions, operations);
      },
      [Symbol.dispose]: () => storage[Symbol.dispose](),
    };
    internals.storage = probe;

    const ops: BatchOperation[] = [{ type: 'put', key: 'k', value: new Uint8Array([7]) }];
    // No base conditions + ownership: 'none' => plain batch with EXACTLY the ops
    // passed (no epoch condition appended, no conditionalBatch path taken).
    await commitFencedEngineWrite(internals, ops, [], () => new Error('unused'));

    expect(conditionalUsed).toBe(false);
    // Identity check via boolean to avoid the `toBe(null)` overload narrowing the
    // closure-assigned variable: the helper passed EXACTLY the caller's ops array.
    expect(plainBatchOps === ops).toBe(true);
    expect(await storage.get('k')).toEqual(new Uint8Array([7]));

    internals.storage = storage;
    await engine[Symbol.asyncDispose]();
    storage[Symbol.dispose]?.();
  });

  it('still honors base conditions under ownership: none (conditionalBatch, no epoch condition)', async () => {
    const storage = new BunSQLiteStorage(':memory:');
    const engine = await Engine.create({
      storage,
      workflows: { 'deposition-waiter': waiterWorkflow },
    });
    const internals = getInternals(engine);

    let seenConditions: ConditionalBatchCondition[] | null = null;
    const probe: Storage = {
      capabilities: () => storage.capabilities(),
      get: (key) => storage.get(key),
      put: (key, value) => storage.put(key, value),
      delete: (key) => storage.delete(key),
      scan: (prefix, options) => storage.scan(prefix, options),
      batch: (operations: BatchOperation[]) => storage.batch(operations),
      conditionalBatch: (conditions: ConditionalBatchCondition[], operations: BatchOperation[]) => {
        seenConditions = conditions;
        return storage.conditionalBatch(conditions, operations);
      },
      [Symbol.dispose]: () => storage[Symbol.dispose](),
    };
    internals.storage = probe;

    const baseConditions: ConditionalBatchCondition[] = [{ key: 'guard', expectedValue: null }];
    await commitFencedEngineWrite(
      internals,
      [{ type: 'put', key: 'guarded', value: new Uint8Array([1]) }],
      baseConditions,
      () => new Error('unused'),
    );

    // The exact base conditions were used, with NO lease-epoch condition appended.
    expect(seenConditions === baseConditions).toBe(true);
    expect(seenConditions!.some((c) => c.key === KEYS.leaseEpoch())).toBe(false);

    internals.storage = storage;
    await engine[Symbol.asyncDispose]();
    storage[Symbol.dispose]?.();
  });

  it('rejects start() in lease mode before the lease is held, then allows it after recoverAll()', async () => {
    // The reachable null-epoch path: `new Engine({ ownership: 'lease' })` does not
    // acquire in the constructor (it cannot await), so a start() before recoverAll()
    // would durably write fresh state without single-writer ownership. The guard on
    // the awaited entry rejects it loudly — a surfacing reject, not the swallowed
    // fenced-write throw — telling the operator to recover first.
    const storage = new BunSQLiteStorage(':memory:');
    const engine = new Engine({ storage, ownership: 'lease' });
    engine.register(waiterWorkflow);

    await expect(
      engine.start('deposition-waiter', null, { id: 'too-early' }),
    ).rejects.toBeInstanceOf(EngineLeaseNotHeldError);
    // startOrSignal shares the precondition.
    await expect(
      engine.startOrSignal('deposition-waiter', null, { name: 'continue' }, { id: 'too-early-2' }),
    ).rejects.toBeInstanceOf(EngineLeaseNotHeldError);

    // After recoverAll() acquires the lease, the same start succeeds.
    await engine.recoverAll();
    const handle = await engine.start('deposition-waiter', null, { id: 'after-recover' });
    expect(handle.id).toBe('after-recover');

    await engine[Symbol.asyncDispose]();
    storage[Symbol.dispose]?.();
  });

  it('rejects start() on a deposed engine (no longer a valid writer)', async () => {
    const storage = new BunSQLiteStorage(':memory:');
    const engine = await Engine.create({
      storage,
      workflows: { 'deposition-waiter': waiterWorkflow },
      ownership: 'lease',
    });
    // Simulate the deposed state the commit-path detection reaches.
    getInternals(engine).deposed = true;

    await expect(
      engine.start('deposition-waiter', null, { id: 'on-deposed' }),
    ).rejects.toBeInstanceOf(EngineLeaseNotHeldError);

    getInternals(engine).deposed = false;
    await engine[Symbol.asyncDispose]();
    storage[Symbol.dispose]?.();
  });

  it('fails closed (no unfenced write) when a lease-mode commit has no held epoch', async () => {
    // Layer-2 backstop for the helper contract: if a durable write is ever attempted
    // in lease mode without a held epoch (an invariant the start guard + boot gates
    // make unreachable), the helper must throw rather than downgrade to an
    // unconditioned batch a deposed instance could exploit.
    const storage = new BunSQLiteStorage(':memory:');
    const engine = await Engine.create({
      storage,
      workflows: { 'deposition-waiter': waiterWorkflow },
      ownership: 'lease',
    });
    const internals = getInternals(engine);

    let touchedStorage = false;
    const probe: Storage = {
      capabilities: () => storage.capabilities(),
      get: (key) => storage.get(key),
      put: (key, value) => storage.put(key, value),
      delete: (key) => storage.delete(key),
      scan: (prefix, options) => storage.scan(prefix, options),
      batch: (operations: BatchOperation[]) => {
        touchedStorage = true;
        return storage.batch(operations);
      },
      conditionalBatch: (conditions: ConditionalBatchCondition[], operations: BatchOperation[]) => {
        touchedStorage = true;
        return storage.conditionalBatch(conditions, operations);
      },
      [Symbol.dispose]: () => storage[Symbol.dispose](),
    };
    internals.storage = probe;
    // Detach the lease manager so currentEpochBytes() is unavailable while ownership
    // is still 'lease' — the invariant-violation state.
    const realManager = internals.leaseManager;
    internals.leaseManager = null;

    await expect(
      commitFencedEngineWrite(
        internals,
        [{ type: 'put', key: 'k', value: new Uint8Array([1]) }],
        [],
        () => new Error('unused'),
      ),
    ).rejects.toThrow(/deposed/i);
    expect(touchedStorage).toBe(false);

    internals.leaseManager = realManager;
    internals.storage = storage;
    await engine[Symbol.asyncDispose]();
    storage[Symbol.dispose]?.();
  });

  it('fails closed (treats as deposed) when the disambiguation re-read of lease:epoch throws', async () => {
    // The liveness fail-closed branch: a fenced CAS returns false, and the
    // re-read of lease:epoch that would classify deposed-vs-lost-race itself
    // throws (a storage blip). Halting is safer than spinning while another
    // instance may own the store — the epoch CAS already blocked the write.
    const storage = new BunSQLiteStorage(':memory:');
    const engine = await Engine.create({
      storage,
      workflows: { 'deposition-waiter': waiterWorkflow },
      ownership: 'lease',
    });
    const internals = getInternals(engine);

    // A storage whose conditionalBatch always fails the CAS and whose subsequent
    // get(lease:epoch) throws, forcing the disambiguation into the catch branch.
    let failedCas = false;
    const probe: Storage = {
      capabilities: () => storage.capabilities(),
      get: (key) => {
        if (failedCas && key === KEYS.leaseEpoch()) {
          throw new Error('storage unavailable during disambiguation');
        }
        return storage.get(key);
      },
      put: (key, value) => storage.put(key, value),
      delete: (key) => storage.delete(key),
      scan: (prefix, options) => storage.scan(prefix, options),
      batch: (operations: BatchOperation[]) => storage.batch(operations),
      conditionalBatch: (
        _conditions: ConditionalBatchCondition[],
        _operations: BatchOperation[],
      ) => {
        failedCas = true;
        return Promise.resolve(false);
      },
      [Symbol.dispose]: () => storage[Symbol.dispose](),
    };
    internals.storage = probe;

    await expect(
      commitFencedEngineWrite(
        internals,
        [{ type: 'put', key: 'k', value: new Uint8Array([1]) }],
        [],
        () => new Error('should not surface — re-read threw, so we halt as deposed'),
      ),
    ).rejects.toThrow(/deposed/i);
    expect(internals.deposed).toBe(true);

    internals.storage = storage;
    await waitForCondition(async () => getInternals(engine).disposed, {
      label: 'deposed engine torn down (re-read-threw path)',
    });
    storage[Symbol.dispose]?.();
  });

  it('precondition-failure variant: returns false on base-condition conflict, halts on deposition', async () => {
    // The idempotent-start fence path: a base-precondition failure with the epoch
    // still held is a legitimate "run already exists" outcome (return false); but a
    // failure caused by a stale epoch (a successor took over) must be a hard halt,
    // never a silent "already exists".
    const storage = new BunSQLiteStorage(':memory:');
    const engine = await Engine.create({
      storage,
      workflows: { 'deposition-waiter': waiterWorkflow },
      ownership: 'lease',
    });
    const internals = getInternals(engine);

    // (1) Base-condition conflict while the epoch is intact → false, NOT deposed.
    await storage.put('exists', new Uint8Array([1]));
    const conflicted = await commitFencedEngineWriteAllowingPreconditionFailure(
      internals,
      [{ type: 'put', key: 'k', value: new Uint8Array([2]) }],
      [{ key: 'exists', expectedValue: null }], // require-absent on a present key → fail
    );
    expect(conflicted).toBe(false);
    expect(internals.deposed).toBe(false);

    // (2) A successor steals the lease → the epoch condition fails → deposition halt.
    await stealLease(storage, 2, 'successor');
    await expect(
      commitFencedEngineWriteAllowingPreconditionFailure(
        internals,
        [{ type: 'put', key: 'k2', value: new Uint8Array([3]) }],
        [],
      ),
    ).rejects.toThrow(/deposed/i);
    expect(internals.deposed).toBe(true);

    await waitForCondition(async () => getInternals(engine).disposed, {
      label: 'deposed engine torn down (precondition variant)',
    });
    storage[Symbol.dispose]?.();
  });
});
