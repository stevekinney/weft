/**
 * Direct unit coverage of `workflow-claim-fold.ts` — the "fold `acquire` into
 * an enabling write" shared helper this stage's claim-acquiring call sites
 * (start, delayed-start fire, bulk retry reactivation) use. End-to-end
 * exercise across two real engines lives in `workflow-claim-two-engine.test.ts`;
 * this file isolates branches that are impractical to force through a full
 * `Engine` — in particular, a lost CAS whose cause is an UNRELATED caller
 * precondition rather than the claim's own conditions.
 */
import { describe, expect, it } from 'bun:test';

import { KEYS, type ConditionalBatchCondition } from '../../storage/interface.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { workflow, type WorkflowContext } from '../types.ts';
import { Engine } from './index.ts';
import { getInternals } from './internals.ts';
import {
  commitWithWorkflowClaimFold,
  prepareWorkflowClaimFold,
  throwWorkflowClaimUnavailable,
} from './workflow-claim-fold.ts';
import { WorkflowClaimRegistry } from './workflow-claim-registry.ts';

const noopWorkflow = workflow({ name: 'workflow-claim-fold-noop' }).execute(async function* (
  ctx: WorkflowContext,
) {
  yield* ctx.waitForSignal('continue');
  return 'done';
});

/** A `workflow-lease` engine with a real, installed claim registry — same pattern as `fenced-write-workflow-scope.test.ts`. */
async function createTestEngine() {
  const engine = await Engine.create({
    storage: new MemoryStorage(),
    workflows: { 'workflow-claim-fold-noop': noopWorkflow },
    ownership: 'workflow-lease',
  });
  const internals = getInternals(engine);
  internals.workflowClaimRegistry = new WorkflowClaimRegistry({
    storage: internals.storage,
    engineId: 'test-engine',
    getNow: () => internals.options.getNow(),
    claimTtlMs: 30_000,
    claimRenewIntervalMs: 5_000,
  });
  return { engine, internals };
}

describe('prepareWorkflowClaimFold', () => {
  it('returns undefined under ownership: "none"', async () => {
    const engine = await Engine.create({ storage: new MemoryStorage() });
    const internals = getInternals(engine);
    expect(await prepareWorkflowClaimFold(internals, 'wf-1')).toBeUndefined();
  });

  it('returns undefined when no registry is constructed, so an unbootstrapped engine folds nothing', async () => {
    // The ownership bootstrap now constructs the registry, so reach the
    // no-registry branch the way production can still hit it: an engine
    // constructed directly and not yet bootstrapped by recoverAll().
    const engine = new Engine({
      storage: new MemoryStorage(),
      ownership: 'workflow-lease',
    });
    const internals = getInternals(engine);
    expect(internals.workflowClaimRegistry).toBeNull();
    expect(await prepareWorkflowClaimFold(internals, 'wf-1')).toBeUndefined();
    engine[Symbol.dispose]();
  });

  it('returns undefined when this engine already tracks a claim for the workflow id', async () => {
    const { internals } = await createTestEngine();
    const registry = internals.workflowClaimRegistry!;
    const acquired = await registry.acquire('wf-already-held');
    expect(acquired.status).toBe('acquired');

    expect(await prepareWorkflowClaimFold(internals, 'wf-already-held')).toBeUndefined();
  });

  it('prepares a fold for a fresh workflow id', async () => {
    const { internals } = await createTestEngine();
    const fold = await prepareWorkflowClaimFold(internals, 'wf-fresh');
    expect(fold).toBeDefined();
    expect(fold?.workflowId).toBe('wf-fresh');
    expect(fold?.conditions).toEqual([
      { key: KEYS.workflowOwnerHolder('wf-fresh'), expectedValue: null },
      { key: KEYS.workflowOwnerEpoch('wf-fresh'), expectedValue: null },
    ]);
  });
});

describe('commitWithWorkflowClaimFold', () => {
  it('commits the fold merged with caller operations/conditions and records the claim', async () => {
    const { internals } = await createTestEngine();
    const fold = await prepareWorkflowClaimFold(internals, 'wf-commit');
    if (fold === undefined) throw new Error('expected a fold');

    const result = await commitWithWorkflowClaimFold(
      internals,
      fold,
      [{ type: 'put', key: 'caller-key', value: new Uint8Array([9]) }],
      [],
      'test commit',
    );

    expect(result).toEqual({ status: 'committed' });
    expect(await internals.storage.get('caller-key')).toEqual(new Uint8Array([9]));
    expect(internals.workflowClaimRegistry?.currentEpoch('wf-commit')).toBe(1);
  });

  it('reports claimConflict: true when the fold itself lost the CAS', async () => {
    const { internals } = await createTestEngine();
    const fold = await prepareWorkflowClaimFold(internals, 'wf-contested');
    if (fold === undefined) throw new Error('expected a fold');

    // A competitor claims the same workflow id first.
    const competitorRegistry = new WorkflowClaimRegistry({
      storage: internals.storage,
      engineId: 'competitor-engine',
      getNow: () => Date.now(),
      claimTtlMs: 30_000,
      claimRenewIntervalMs: 5_000,
    });
    const competitorAcquireResult = await competitorRegistry.acquire('wf-contested');
    expect(competitorAcquireResult.status).toBe('acquired');

    const result = await commitWithWorkflowClaimFold(internals, fold, [], [], 'test commit');
    expect(result).toEqual({ status: 'lost-race', claimConflict: true });
    // A lost claim fold must never install tracking for a claim this engine does not hold.
    expect(internals.workflowClaimRegistry?.currentEpoch('wf-contested')).toBeNull();
  });

  it('reports claimConflict: false when an UNRELATED caller precondition lost the CAS', async () => {
    const { internals } = await createTestEngine();
    const fold = await prepareWorkflowClaimFold(internals, 'wf-unrelated-conflict');
    if (fold === undefined) throw new Error('expected a fold');

    // A caller precondition (e.g. an idempotency mapping) that has already
    // changed by commit time — nothing to do with the claim's own keys.
    await internals.storage.put('idempotency-key', new Uint8Array([1]));
    const callerCondition: ConditionalBatchCondition = {
      key: 'idempotency-key',
      expectedValue: null,
    };

    const result = await commitWithWorkflowClaimFold(
      internals,
      fold,
      [{ type: 'put', key: 'never-written', value: new Uint8Array([1]) }],
      [callerCondition],
      'test commit',
    );

    expect(result).toEqual({ status: 'lost-race', claimConflict: false });
    expect(internals.workflowClaimRegistry?.currentEpoch('wf-unrelated-conflict')).toBeNull();
    // The claim's own conditions still held — proven by a fresh prepare
    // reading the SAME never-incremented epoch (still absent).
    const retry = await prepareWorkflowClaimFold(internals, 'wf-unrelated-conflict');
    expect(retry?.preparation.epoch).toBe(1);
  });
});

describe('throwWorkflowClaimUnavailable', () => {
  it('raises WorkflowClaimUnavailableError carrying the current holder engineId', async () => {
    const { internals } = await createTestEngine();
    const competitorRegistry = new WorkflowClaimRegistry({
      storage: internals.storage,
      engineId: 'holder-engine',
      getNow: () => Date.now(),
      claimTtlMs: 30_000,
      claimRenewIntervalMs: 5_000,
    });
    const holderAcquireResult = await competitorRegistry.acquire('wf-held');
    expect(holderAcquireResult.status).toBe('acquired');

    await expect(throwWorkflowClaimUnavailable(internals, 'wf-held')).rejects.toMatchObject({
      name: 'WorkflowClaimUnavailableError',
      workflowId: 'wf-held',
      heldBy: 'holder-engine',
    });
  });

  it('reports heldBy: null when the holder record is absent', async () => {
    const { internals } = await createTestEngine();
    await expect(throwWorkflowClaimUnavailable(internals, 'wf-no-holder')).rejects.toMatchObject({
      workflowId: 'wf-no-holder',
      heldBy: null,
    });
  });
});
