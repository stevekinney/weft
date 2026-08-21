/**
 * ADR 0002 (`documentation/contributing/architecture-decisions/0002-multiengine-per-workflow-ownership.md`)
 * stage 89: `commitFencedEngineWrite` / `commitFencedEngineWriteAllowingPreconditionFailure`
 * gain a REQUIRED `workflowId: string | null` parameter. This file is the
 * direct unit coverage of the new branch in `fenced-write.ts` that parameter
 * selects: a workflow-scoped write (`workflowId` non-null) under
 * `ownership: 'workflow-lease'` is additionally fenced on
 * `wf-owner-epoch:<workflowId>` — ON TOP OF, never instead of, the caller's
 * base conditions and (when the storage adapter needs one) the checkpoint-head
 * condition callers already supply. Losing that fence deposes ONLY that one
 * workflow (warn + throw `EngineDeposedError(workflowId)`) — it never sets
 * `EngineInternals.deposed` and never halts the engine, unlike global
 * `ownership: 'lease'` deposition (still covered end-to-end in
 * `lease-deposition.test.ts`).
 *
 * `EngineInternals.workflowClaimRegistry` is not yet wired by `Engine.create()`
 * — that is a later stage (Gate 1/Gate 2, folding `acquire()` into start/
 * resume/delayed-start-fire). Every test here installs a `WorkflowClaimRegistry`
 * directly onto `internals` and drives `acquire()` itself, standing in for what
 * that later stage will do automatically. Until then, every workflow-scoped
 * write under `'workflow-lease'` fails closed with no claim held — proven
 * below as the "no held claim" case, not treated as a bug.
 */
import { describe, expect, it } from 'bun:test';

import type {
  BatchOperation,
  ConditionalBatchCondition,
  Storage,
} from '../../storage/interface.ts';
import { KEYS } from '../../storage/interface.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { workflow, type WorkflowContext } from '../types.ts';
import {
  commitFencedEngineWrite,
  commitFencedEngineWriteAllowingPreconditionFailure,
} from './fenced-write.ts';
import { Engine } from './index.ts';
import { getInternals } from './internals.ts';
import { WeftWorkflowClaimLostWarning } from './lease-deposition.ts';
import { EngineDeposedError } from './lease-errors.ts';
import { encodeEpoch, encodeWorkflowClaimHolder } from './workflow-claim-codec.ts';
import { WorkflowClaimRegistry } from './workflow-claim-registry.ts';

const noopWorkflow = workflow({ name: 'fenced-write-workflow-scope-noop' }).execute(
  async function* (ctx: WorkflowContext) {
    yield* ctx.waitForSignal('continue');
    return 'done';
  },
);

/** A minimal `Engine` whose internals we poke directly — mirrors lease-deposition.test.ts's pattern. */
async function createTestEngine(ownership: 'none' | 'lease' | 'workflow-lease') {
  const engine = await Engine.create({
    storage: new MemoryStorage(),
    workflows: { 'fenced-write-workflow-scope-noop': noopWorkflow },
    ...(ownership === 'none' ? {} : { ownership }),
  });
  return { engine };
}

/** Install a claim registry on `internals` and acquire `workflowId` through it. */
async function installAndAcquireClaim(
  internals: ReturnType<typeof getInternals>,
  workflowId: string,
): Promise<WorkflowClaimRegistry> {
  const registry = new WorkflowClaimRegistry({
    storage: internals.storage,
    engineId: 'test-engine',
    getNow: () => internals.options.getNow(),
    claimTtlMs: 30_000,
    claimRenewIntervalMs: 5_000,
  });
  internals.workflowClaimRegistry = registry;
  const result = await registry.acquire(workflowId);
  expect(result.status).toBe('acquired');
  return registry;
}

/** Overwrite `wf-owner-epoch:<workflowId>` directly, simulating another engine's takeover. */
async function stealWorkflowClaim(
  storage: Storage,
  workflowId: string,
  newEpoch: number,
): Promise<void> {
  await storage.batch([
    { type: 'put', key: KEYS.workflowOwnerEpoch(workflowId), value: encodeEpoch(newEpoch) },
    {
      type: 'put',
      key: KEYS.workflowOwnerHolder(workflowId),
      value: encodeWorkflowClaimHolder({
        engineId: 'successor-engine',
        epoch: newEpoch,
        expiresAt: Date.now() + 60_000,
        claimedAt: Date.now(),
      }),
    },
  ]);
}

function conditionKeys(conditions: ConditionalBatchCondition[]): string[] {
  return conditions.map((condition) => condition.key);
}

/**
 * Wrap `base` in an explicit delegating `Storage`, overriding only the given
 * hooks. A plain object spread (`{ ...base }`) does NOT work here — `base` is
 * a class instance, and spread only copies its own enumerable properties, not
 * its prototype methods (`capabilities`, `get`, `put`, ...), so a spread probe
 * silently loses everything but its own fields.
 */
function withStorageHooks(
  base: Storage,
  hooks: Partial<Pick<Storage, 'batch' | 'conditionalBatch' | 'get'>>,
): Storage {
  return {
    capabilities: () => base.capabilities(),
    get: hooks.get ?? ((key) => base.get(key)),
    put: (key, value) => base.put(key, value),
    delete: (key) => base.delete(key),
    scan: (prefix, options) => base.scan(prefix, options),
    batch: hooks.batch ?? ((operations) => base.batch(operations)),
    conditionalBatch:
      hooks.conditionalBatch ??
      ((conditions, operations) => base.conditionalBatch!(conditions, operations)),
    [Symbol.dispose]: () => base[Symbol.dispose](),
  };
}

describe('fenced-write.ts: per-workflow scope (ADR 0002, stage 89)', () => {
  it('appends the wf-owner-epoch condition, on top of base conditions, under workflow-lease', async () => {
    const { engine } = await createTestEngine('workflow-lease');
    const internals = getInternals(engine);
    await installAndAcquireClaim(internals, 'wf-a');

    let seenConditions: ConditionalBatchCondition[] | null = null;
    const base = internals.storage;
    internals.storage = withStorageHooks(base, {
      conditionalBatch: (conditions, operations) => {
        seenConditions = conditions;
        return base.conditionalBatch!(conditions, operations);
      },
    });

    const baseConditions: ConditionalBatchCondition[] = [{ key: 'guard', expectedValue: null }];
    await commitFencedEngineWrite(
      internals,
      'wf-a',
      [{ type: 'put', key: 'k', value: new Uint8Array([1]) }],
      baseConditions,
      () => new Error('unused'),
    );

    expect(seenConditions).not.toBeNull();
    const keys = conditionKeys(seenConditions!);
    // Both the caller's base condition AND the per-workflow epoch condition
    // are present — additive, never a replacement.
    expect(keys).toContain('guard');
    expect(keys).toContain(KEYS.workflowOwnerEpoch('wf-a'));
    expect(keys.length).toBe(2);

    await engine[Symbol.asyncDispose]();
  });

  it('does NOT append the workflow epoch condition under ownership: lease, even with a non-null workflowId', async () => {
    const { engine } = await createTestEngine('lease');
    const internals = getInternals(engine);

    let seenConditions: ConditionalBatchCondition[] | null = null;
    const base = internals.storage;
    internals.storage = withStorageHooks(base, {
      conditionalBatch: (conditions, operations) => {
        seenConditions = conditions;
        return base.conditionalBatch!(conditions, operations);
      },
    });

    await commitFencedEngineWrite(
      internals,
      'wf-a',
      [{ type: 'put', key: 'k', value: new Uint8Array([1]) }],
      [],
      () => new Error('unused'),
    );

    expect(seenConditions).not.toBeNull();
    const keys = conditionKeys(seenConditions!);
    expect(keys).toContain(KEYS.leaseEpoch());
    expect(keys).not.toContain(KEYS.workflowOwnerEpoch('wf-a'));

    await engine[Symbol.asyncDispose]();
  });

  it('does NOT append the workflow epoch condition under ownership: none, even with a non-null workflowId', async () => {
    const { engine } = await createTestEngine('none');
    const internals = getInternals(engine);

    let plainBatchOps: BatchOperation[] | null = null;
    const base = internals.storage;
    internals.storage = withStorageHooks(base, {
      batch: (operations) => {
        plainBatchOps = operations;
        return base.batch(operations);
      },
    });

    const ops: BatchOperation[] = [{ type: 'put', key: 'k', value: new Uint8Array([7]) }];
    await commitFencedEngineWrite(internals, 'wf-a', ops, [], () => new Error('unused'));

    // No base conditions + no epoch condition => the plain-batch shortcut, byte
    // for byte identical to `workflowId: null`: passing a non-null workflowId
    // under `ownership: 'none'` changes nothing.
    expect(plainBatchOps === ops).toBe(true);

    await engine[Symbol.asyncDispose]();
  });

  it('an engine-scoped write (workflowId: null) never carries the epoch condition under workflow-lease, even while a claim is held', async () => {
    const { engine } = await createTestEngine('workflow-lease');
    const internals = getInternals(engine);
    // Hold a real claim for a DIFFERENT workflow, to prove an engine-scoped
    // write does not pick it up.
    await installAndAcquireClaim(internals, 'wf-a');

    let seenConditions: ConditionalBatchCondition[] | null = null;
    const base = internals.storage;
    internals.storage = withStorageHooks(base, {
      conditionalBatch: (conditions, operations) => {
        seenConditions = conditions;
        return base.conditionalBatch!(conditions, operations);
      },
    });

    const baseConditions: ConditionalBatchCondition[] = [{ key: 'guard', expectedValue: null }];
    await commitFencedEngineWrite(
      internals,
      null,
      [{ type: 'put', key: 'k', value: new Uint8Array([1]) }],
      baseConditions,
      () => new Error('unused'),
    );

    expect(seenConditions).not.toBeNull();
    expect(conditionKeys(seenConditions!)).toEqual(['guard']);

    await engine[Symbol.asyncDispose]();
  });

  it('fails closed with no storage round trip when this engine holds no claim for the workflow', async () => {
    const { engine } = await createTestEngine('workflow-lease');
    const internals = getInternals(engine);
    // A registry is installed but nothing was ever acquired for 'wf-unclaimed'.
    internals.workflowClaimRegistry = new WorkflowClaimRegistry({
      storage: internals.storage,
      engineId: 'test-engine',
      getNow: () => internals.options.getNow(),
      claimTtlMs: 30_000,
      claimRenewIntervalMs: 5_000,
    });

    let touchedStorage = false;
    const base = internals.storage;
    internals.storage = withStorageHooks(base, {
      batch: (operations) => {
        touchedStorage = true;
        return base.batch(operations);
      },
      conditionalBatch: (conditions, operations) => {
        touchedStorage = true;
        return base.conditionalBatch!(conditions, operations);
      },
    });

    const warnings: WeftWorkflowClaimLostWarning[] = [];
    const listener = (warning: Error): void => {
      if (warning instanceof WeftWorkflowClaimLostWarning) warnings.push(warning);
    };
    process.on('warning', listener);

    try {
      await expect(
        commitFencedEngineWrite(
          internals,
          'wf-unclaimed',
          [{ type: 'put', key: 'k', value: new Uint8Array([1]) }],
          [],
          () => new Error('should not surface — deposed, not lost-race'),
        ),
      ).rejects.toThrow(EngineDeposedError);
    } finally {
      process.off('warning', listener);
    }

    expect(touchedStorage).toBe(false);
    expect(internals.deposed).toBe(false);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.workflowId).toBe('wf-unclaimed');

    await engine[Symbol.asyncDispose]();
  });

  it('disambiguates a lost-race base-condition conflict from a deposed epoch: base conflict throws onLostRace, not EngineDeposedError', async () => {
    const { engine } = await createTestEngine('workflow-lease');
    const internals = getInternals(engine);
    await installAndAcquireClaim(internals, 'wf-a');
    await internals.storage.put('exists', new Uint8Array([1]));

    const lostRace = new Error('lost the base-condition race');
    await expect(
      commitFencedEngineWrite(
        internals,
        'wf-a',
        [{ type: 'put', key: 'k', value: new Uint8Array([1]) }],
        [{ key: 'exists', expectedValue: null }], // require-absent on a present key => fails
        () => lostRace,
      ),
    ).rejects.toBe(lostRace);
    expect(internals.deposed).toBe(false);

    await engine[Symbol.asyncDispose]();
  });

  it('disambiguates a deposed epoch from a base-condition conflict: a stolen claim throws EngineDeposedError(workflowId) even with no base conditions', async () => {
    const { engine } = await createTestEngine('workflow-lease');
    const internals = getInternals(engine);
    await installAndAcquireClaim(internals, 'wf-a');
    await stealWorkflowClaim(internals.storage, 'wf-a', 99);

    const warnings: WeftWorkflowClaimLostWarning[] = [];
    const listener = (warning: Error): void => {
      if (warning instanceof WeftWorkflowClaimLostWarning) warnings.push(warning);
    };
    process.on('warning', listener);

    try {
      await expect(
        commitFencedEngineWrite(
          internals,
          'wf-a',
          [{ type: 'put', key: 'k', value: new Uint8Array([1]) }],
          [],
          () => new Error('should not surface — the epoch fence was the one that failed'),
        ),
      ).rejects.toThrow(EngineDeposedError);
    } finally {
      process.off('warning', listener);
    }

    expect(internals.deposed).toBe(false);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.workflowId).toBe('wf-a');

    await engine[Symbol.asyncDispose]();
  });

  it('fails closed (treats as deposed) when the disambiguation re-read of wf-owner-epoch throws', async () => {
    // Mirrors lease-deposition.test.ts's global-lease analogue: a fenced CAS
    // returns false, and the re-read that would classify deposed-vs-lost-race
    // itself throws (a storage blip). Halting is safer than spinning while
    // another engine may hold the claim — the epoch CAS already blocked the write.
    const { engine } = await createTestEngine('workflow-lease');
    const internals = getInternals(engine);
    await installAndAcquireClaim(internals, 'wf-a');

    let failedCas = false;
    const base = internals.storage;
    internals.storage = withStorageHooks(base, {
      get: (key) => {
        if (failedCas && key === KEYS.workflowOwnerEpoch('wf-a')) {
          throw new Error('storage unavailable during disambiguation');
        }
        return base.get(key);
      },
      conditionalBatch: () => {
        failedCas = true;
        return Promise.resolve(false);
      },
    });

    await expect(
      commitFencedEngineWrite(
        internals,
        'wf-a',
        [{ type: 'put', key: 'k', value: new Uint8Array([1]) }],
        [],
        () => new Error('should not surface — re-read threw, so we halt as deposed'),
      ),
    ).rejects.toThrow(EngineDeposedError);
    expect(internals.deposed).toBe(false);

    await engine[Symbol.asyncDispose]();
  });

  it('commitFencedEngineWriteAllowingPreconditionFailure still hard-halts on a deposed epoch instead of returning false', async () => {
    const { engine } = await createTestEngine('workflow-lease');
    const internals = getInternals(engine);
    await installAndAcquireClaim(internals, 'wf-a');

    // (1) An ordinary base-precondition conflict, epoch intact: false, not deposed.
    await internals.storage.put('exists', new Uint8Array([1]));
    const conflicted = await commitFencedEngineWriteAllowingPreconditionFailure(
      internals,
      'wf-a',
      [{ type: 'put', key: 'k', value: new Uint8Array([2]) }],
      [{ key: 'exists', expectedValue: null }],
    );
    expect(conflicted).toBe(false);
    expect(internals.deposed).toBe(false);

    // (2) The claim is stolen: the epoch condition itself fails => hard halt,
    // never a silent `false` a caller could misread as "already exists".
    await stealWorkflowClaim(internals.storage, 'wf-a', 42);
    await expect(
      commitFencedEngineWriteAllowingPreconditionFailure(
        internals,
        'wf-a',
        [{ type: 'put', key: 'k2', value: new Uint8Array([3]) }],
        [],
      ),
    ).rejects.toThrow(EngineDeposedError);
    expect(internals.deposed).toBe(false);

    await engine[Symbol.asyncDispose]();
  });

  it('deposing one workflow does not affect another workflow this engine still validly claims', async () => {
    const { engine } = await createTestEngine('workflow-lease');
    const internals = getInternals(engine);
    await installAndAcquireClaim(internals, 'wf-a');
    // A second `acquire` on the SAME registry for a different id: the registry
    // tracks both claims independently.
    const registry = internals.workflowClaimRegistry!;
    const acquiredB = await registry.acquire('wf-b');
    expect(acquiredB.status).toBe('acquired');

    // wf-a is stolen by a successor; wf-b is untouched.
    await stealWorkflowClaim(internals.storage, 'wf-a', 7);

    await expect(
      commitFencedEngineWrite(
        internals,
        'wf-a',
        [{ type: 'put', key: 'a', value: new Uint8Array([1]) }],
        [],
        () => new Error('unused'),
      ),
    ).rejects.toThrow(EngineDeposedError);

    // wf-b's write commits normally — this engine's own halt for wf-a never
    // touched wf-b's tracked claim or the shared `internals.deposed` flag.
    await commitFencedEngineWrite(
      internals,
      'wf-b',
      [{ type: 'put', key: 'b', value: new Uint8Array([2]) }],
      [],
      () => new Error('unused'),
    );
    expect(await internals.storage.get('b')).toEqual(new Uint8Array([2]));
    expect(internals.deposed).toBe(false);

    await engine[Symbol.asyncDispose]();
  });

  it('global lease deposition still halts the engine even when the write states a workflowId', async () => {
    const { engine } = await createTestEngine('lease');
    const internals = getInternals(engine);

    // Steal the GLOBAL lease (not a per-workflow claim) at a newer epoch.
    await internals.storage.batch([
      { type: 'put', key: KEYS.leaseEpoch(), value: encodeEpoch(2) },
      {
        type: 'put',
        key: KEYS.leaseHolder(),
        value: new TextEncoder().encode(
          JSON.stringify({ holderId: 'successor', expiresAt: Date.now() + 60_000, epoch: 2 }),
        ),
      },
    ]);

    // Even though this write names a workflowId, `ownership: 'lease'` ignores
    // it entirely and fences on the GLOBAL epoch — losing it sets the
    // engine-wide `deposed` flag, unlike the per-workflow case above.
    await expect(
      commitFencedEngineWrite(
        internals,
        'wf-a',
        [{ type: 'put', key: 'k', value: new Uint8Array([1]) }],
        [],
        () => new Error('unused'),
      ),
    ).rejects.toThrow(EngineDeposedError);
    expect(internals.deposed).toBe(true);

    await engine[Symbol.asyncDispose]();
  });
});
