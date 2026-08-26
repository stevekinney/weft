/**
 * A serial renewal loop costs one storage round trip per held claim before
 * returning to the first, so with many claims on a high-latency store the pass
 * itself can outlast `workflowClaimTtl` — later claims expire before their
 * first renewal, earlier ones before the next pass. Separating the reclaim scan
 * out of the renewal single-flight does not bound this loop; only limiting how
 * long the loop itself takes does.
 *
 * These assert the bound structurally — peak in-flight renewals — rather than
 * by elapsed time, so there is no wall-clock sleep and no load sensitivity.
 */
import { describe, expect, it } from 'bun:test';

import { createDeferred } from '../../testing/fake-timers.test-support.ts';
import type {
  WorkflowClaimReclaimAttemptResult,
  WorkflowClaimReclaimTarget,
  WorkflowClaimRenewalTarget,
} from './workflow-claim-renewal-subpasses.ts';
import {
  runReclaimPass,
  runRenewalSubPass,
  WORKFLOW_CLAIM_RECLAIM_CONCURRENCY,
  WORKFLOW_CLAIM_RENEWAL_CONCURRENCY,
} from './workflow-claim-renewal-subpasses.ts';

/**
 * A renewal target that never settles a call until released, recording how many
 * renewals are in flight at once.
 */
function createConcurrencyProbe(failing: ReadonlySet<string> = new Set()) {
  const gates: Array<() => void> = [];
  let inFlight = 0;
  let peakInFlight = 0;
  const started: string[] = [];

  const target: WorkflowClaimRenewalTarget = {
    listHeldWorkflowIds: () => [],
    renewWorkflowClaim: async (workflowId: string) => {
      started.push(workflowId);
      inFlight += 1;
      peakInFlight = Math.max(peakInFlight, inFlight);
      const gate = createDeferred();
      gates.push(() => gate.resolve());
      await gate.promise;
      inFlight -= 1;
      if (failing.has(workflowId)) throw new Error(`renewal failed for ${workflowId}`);
    },
  };

  return {
    target,
    started,
    get peakInFlight() {
      return peakInFlight;
    },
    /** Release every renewal currently parked, repeatedly, until the pass ends. */
    async drain(): Promise<void> {
      for (let turn = 0; turn < 200 && gates.length > 0; turn += 1) {
        const pending = gates.splice(0, gates.length);
        for (const release of pending) release();
        await Promise.resolve();
        await Promise.resolve();
      }
    },
  };
}

describe('claim renewal runs through a bounded pool', () => {
  it('overlaps renewals instead of taking one round trip at a time', async () => {
    const workflowIds = Array.from({ length: 40 }, (_, index) => `workflow-${index}`);
    const probe = createConcurrencyProbe();

    const pass = runRenewalSubPass(probe.target, workflowIds);
    await probe.drain();
    const result = await pass;

    // Serial renewal never exceeds one in flight; that is the bug.
    expect(probe.peakInFlight).toBeGreaterThan(1);
    // And it must stay bounded rather than fanning out over every claim, which
    // would trade starvation for a storage stampede.
    expect(probe.peakInFlight).toBeLessThanOrEqual(WORKFLOW_CLAIM_RENEWAL_CONCURRENCY);
    expect(result.renewedCount).toBe(40);
    expect(result.failedCount).toBe(0);
  });

  it('keeps outcomes positional and isolates a per-workflow failure', async () => {
    const workflowIds = Array.from({ length: 20 }, (_, index) => `workflow-${index}`);
    const probe = createConcurrencyProbe(new Set(['workflow-3', 'workflow-17']));

    const pass = runRenewalSubPass(probe.target, workflowIds);
    await probe.drain();
    const result = await pass;

    // Results arrive out of order under a pool; the array must not.
    expect(result.outcomes.map((outcome) => outcome.workflowId)).toEqual(workflowIds);
    expect(result.failedCount).toBe(2);
    expect(result.renewedCount).toBe(18);
    expect(result.outcomes[3]?.status).toBe('failed');
    expect(result.outcomes[17]?.status).toBe('failed');
    // Losing one claim stops only that workflow.
    expect(result.outcomes[4]?.status).toBe('renewed');
  });

  it('renews a single claim without pool overhead', async () => {
    // The common case. Nothing to overlap, so this must stay a plain awaited
    // call — the pool's extra async frames would shift the interleaving that
    // the interval task's single-flight tests depend on.
    const probe = createConcurrencyProbe();

    const pass = runRenewalSubPass(probe.target, ['workflow-only']);
    await probe.drain();
    const result = await pass;

    expect(probe.peakInFlight).toBe(1);
    expect(result.renewedCount).toBe(1);
    expect(result.outcomes).toEqual([{ workflowId: 'workflow-only', status: 'renewed' }]);
  });

  it('isolates a failure on the pool-free single-claim path', async () => {
    // The <=1 branch duplicates the pool's try/catch rather than delegating
    // to it (see the module doc); a failing single claim must still surface
    // as a `'failed'` outcome instead of rejecting the pass.
    const probe = createConcurrencyProbe(new Set(['workflow-only']));

    const pass = runRenewalSubPass(probe.target, ['workflow-only']);
    await probe.drain();
    const result = await pass;

    expect(result.failedCount).toBe(1);
    expect(result.renewedCount).toBe(0);
    expect(result.outcomes[0]?.status).toBe('failed');
    expect((result.outcomes[0] as { error: unknown }).error).toBeInstanceOf(Error);
  });
});

/**
 * A reclaim target whose `attemptWorkflowClaimTakeover` never settles for a
 * specific set of "gated" workflow ids until explicitly released — modeling a
 * stuck `onReclaimed` drive (e.g. a stalled storage read during replay).
 * Ungated ids resolve immediately.
 */
function createReclaimConcurrencyProbe(gatedWorkflowIds: ReadonlySet<string>) {
  const gates: Array<() => void> = [];
  const attempted: string[] = [];

  const target: WorkflowClaimReclaimTarget = {
    listReclaimCandidateWorkflowIds: async () => [],
    attemptWorkflowClaimTakeover: async (
      workflowId: string,
    ): Promise<WorkflowClaimReclaimAttemptResult> => {
      attempted.push(workflowId);
      if (gatedWorkflowIds.has(workflowId)) {
        const gate = createDeferred();
        gates.push(() => gate.resolve());
        await gate.promise;
      }
      return { status: 'reclaimed' };
    },
  };

  return {
    target,
    attempted,
    /** Release every gated attempt currently parked. */
    releaseGated(): void {
      const pending = gates.splice(0, gates.length);
      for (const release of pending) release();
    },
  };
}

describe('claim reclaim runs candidates through a bounded pool (WFT-79)', () => {
  it('does not let one stuck onReclaimed drive block a later candidate from being attempted', async () => {
    const workflowIds = ['wf-stuck', 'wf-a', 'wf-b', 'wf-c'];
    const probe = createReclaimConcurrencyProbe(new Set(['wf-stuck']));
    const target: WorkflowClaimReclaimTarget = {
      listReclaimCandidateWorkflowIds: async () => workflowIds,
      attemptWorkflowClaimTakeover: probe.target.attemptWorkflowClaimTakeover,
    };

    const pass = runReclaimPass(target);
    // Let the pool start every worker before asserting: a serial loop would
    // never reach 'wf-a'/'wf-b'/'wf-c' while 'wf-stuck' is still parked.
    await Promise.resolve();
    await Promise.resolve();

    expect(probe.attempted).toContain('wf-a');
    expect(probe.attempted).toContain('wf-b');
    expect(probe.attempted).toContain('wf-c');

    probe.releaseGated();
    const result = await pass;

    expect(result.status).toBe('completed');
    if (result.status === 'completed') {
      expect(result.reclaimedCount).toBe(4);
      // Positional, matching candidate order, regardless of settle order.
      expect(result.outcomes.map((outcome) => outcome.workflowId)).toEqual(workflowIds);
    }
  });

  it('stays bounded rather than fanning out over every candidate at once', async () => {
    const workflowIds = Array.from({ length: 40 }, (_, index) => `wf-${index}`);
    let inFlight = 0;
    let peakInFlight = 0;
    const gates: Array<() => void> = [];
    const target: WorkflowClaimReclaimTarget = {
      listReclaimCandidateWorkflowIds: async () => workflowIds,
      attemptWorkflowClaimTakeover: async () => {
        inFlight += 1;
        peakInFlight = Math.max(peakInFlight, inFlight);
        const gate = createDeferred();
        gates.push(() => gate.resolve());
        await gate.promise;
        inFlight -= 1;
        return { status: 'reclaimed' };
      },
    };

    const pass = runReclaimPass(target);
    for (let turn = 0; turn < 200 && gates.length < workflowIds.length; turn += 1) {
      const pending = gates.splice(0, gates.length);
      for (const release of pending) release();
      await Promise.resolve();
      await Promise.resolve();
    }
    const pending = gates.splice(0, gates.length);
    for (const release of pending) release();
    const result = await pass;

    expect(peakInFlight).toBeGreaterThan(1);
    expect(peakInFlight).toBeLessThanOrEqual(WORKFLOW_CLAIM_RECLAIM_CONCURRENCY);
    expect(result.status).toBe('completed');
    if (result.status === 'completed') expect(result.reclaimedCount).toBe(40);
  });
});
