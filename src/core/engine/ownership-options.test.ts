import { describe, expect, it } from 'bun:test';

import { MemoryStorage } from '../../storage/memory.ts';
import { workflow } from '../types.ts';
import type { EngineConstructorOptions } from './engine-internal-types.ts';
import { Engine } from './index.ts';
import {
  DEFAULT_LEASE_RENEW_INTERVAL_MS,
  DEFAULT_LEASE_TTL_MS,
  DEFAULT_LEASE_WAIT_TIMEOUT_MS,
  DEFAULT_WORKFLOW_CLAIM_RENEW_INTERVAL_MS,
  DEFAULT_WORKFLOW_CLAIM_TTL_MS,
  resolveBackgroundTaskMode,
  resolveOwnershipFields,
  WORKFLOW_CLAIM_TTL_SAFETY_MULTIPLIER,
} from './ownership-options.ts';

/**
 * Direct unit coverage of `ownership-options.ts` for the three-member
 * `'none' | 'lease' | 'workflow-lease'` posture, calling `resolveOwnershipFields`
 * and `resolveBackgroundTaskMode` directly rather than through
 * `resolveEngineOptions`. `construction.test.ts` already covers the `'none'`/
 * `'lease'` behavior end-to-end through `resolveEngineOptions`; this file
 * focuses on the `'workflow-lease'` surface this module adds, plus the
 * defaulting behavior every posture now returns for the new workflow-claim
 * fields.
 */

function resolve(options: EngineConstructorOptions | undefined) {
  return resolveOwnershipFields(options);
}

describe('resolveOwnershipFields', () => {
  it("defaults to 'none' with both lease and workflow-claim tuning at documented defaults", () => {
    const resolved = resolve(undefined);

    expect(resolved.ownershipMode).toBe('none');
    expect(resolved.leaseTtlMs).toBe(DEFAULT_LEASE_TTL_MS);
    expect(resolved.leaseRenewIntervalMs).toBe(DEFAULT_LEASE_RENEW_INTERVAL_MS);
    expect(resolved.leaseWaitTimeoutMs).toBe(DEFAULT_LEASE_WAIT_TIMEOUT_MS);
    expect(resolved.workflowClaimTtlMs).toBe(DEFAULT_WORKFLOW_CLAIM_TTL_MS);
    expect(resolved.workflowClaimRenewIntervalMs).toBe(DEFAULT_WORKFLOW_CLAIM_RENEW_INTERVAL_MS);
  });

  it('throws on an unknown ownership posture, listing all three accepted values', () => {
    expect(() => resolve({ ownership: 'leases' as never })).toThrow(
      /Unknown ownership posture "leases"\. Expected 'none', 'lease', or 'workflow-lease'\./,
    );
  });

  it("returns workflow-claim defaults (unvalidated) when ownership is 'lease'", () => {
    // The workflow-claim fields are meaningless outside 'workflow-lease'; a
    // 'lease' engine must still get a fully populated ResolvedOptions.
    const resolved = resolve({ ownership: 'lease' });

    expect(resolved.ownershipMode).toBe('lease');
    expect(resolved.workflowClaimTtlMs).toBe(DEFAULT_WORKFLOW_CLAIM_TTL_MS);
    expect(resolved.workflowClaimRenewIntervalMs).toBe(DEFAULT_WORKFLOW_CLAIM_RENEW_INTERVAL_MS);
  });

  it("applies workflow-claim defaults for omitted tuning fields under ownership 'workflow-lease'", () => {
    const resolved = resolve({ ownership: 'workflow-lease' });

    expect(resolved.ownershipMode).toBe('workflow-lease');
    expect(resolved.workflowClaimTtlMs).toBe(DEFAULT_WORKFLOW_CLAIM_TTL_MS);
    expect(resolved.workflowClaimRenewIntervalMs).toBe(DEFAULT_WORKFLOW_CLAIM_RENEW_INTERVAL_MS);
    // Lease fields stay at their own defaults too — 'workflow-lease' does not
    // touch the global lease tuning.
    expect(resolved.leaseTtlMs).toBe(DEFAULT_LEASE_TTL_MS);
    expect(resolved.leaseRenewIntervalMs).toBe(DEFAULT_LEASE_RENEW_INTERVAL_MS);
  });

  it("resolves explicit workflow-claim tuning durations under ownership 'workflow-lease'", () => {
    const resolved = resolve({
      ownership: 'workflow-lease',
      workflowClaimTtl: '45s',
      workflowClaimRenewInterval: '7s',
    });

    expect(resolved.workflowClaimTtlMs).toBe(45_000);
    expect(resolved.workflowClaimRenewIntervalMs).toBe(7_000);
  });

  it("does not validate workflow-claim durations when ownership is not 'workflow-lease'", () => {
    // Documented as "ignored" outside 'workflow-lease', so an invalid duration
    // must not make an off-by-default config fatal at construction.
    const resolved = resolve({ workflowClaimTtl: 'not-a-duration' as never });

    expect(resolved.ownershipMode).toBe('none');
    expect(resolved.workflowClaimTtlMs).toBe(DEFAULT_WORKFLOW_CLAIM_TTL_MS);
  });

  it("throws on an invalid workflow-claim duration under ownership 'workflow-lease'", () => {
    expect(() =>
      resolve({ ownership: 'workflow-lease', workflowClaimTtl: 'bogus' as never }),
    ).toThrow();
  });

  it("throws when workflowClaimRenewInterval >= workflowClaimTtl under ownership 'workflow-lease'", () => {
    expect(() =>
      resolve({
        ownership: 'workflow-lease',
        workflowClaimTtl: '10s',
        workflowClaimRenewInterval: '10s',
      }),
    ).toThrow(/workflowClaimRenewInterval \(10000ms\) to be strictly less than/);
    expect(() =>
      resolve({
        ownership: 'workflow-lease',
        workflowClaimTtl: '10s',
        workflowClaimRenewInterval: '20s',
      }),
    ).toThrow(/workflowClaimRenewInterval/);
  });

  it('accepts workflowClaimRenewInterval strictly less than workflowClaimTtl when the multiplier floor also holds', () => {
    const resolved = resolve({
      ownership: 'workflow-lease',
      workflowClaimTtl: '30s',
      workflowClaimRenewInterval: '9999ms',
    });

    expect(resolved.workflowClaimRenewIntervalMs).toBe(9_999);
    expect(resolved.workflowClaimTtlMs).toBe(30_000);
  });

  it('throws when workflowClaimTtl is below WORKFLOW_CLAIM_TTL_SAFETY_MULTIPLIER times workflowClaimRenewInterval', () => {
    // renewInterval (10s) < ttl (20s) holds, but 20s < 3 * 10s = 30s, so the
    // safety-margin relationship is what must reject this.
    expect(WORKFLOW_CLAIM_TTL_SAFETY_MULTIPLIER).toBe(3);
    expect(() =>
      resolve({
        ownership: 'workflow-lease',
        workflowClaimTtl: '20s',
        workflowClaimRenewInterval: '10s',
      }),
    ).toThrow(
      /workflowClaimTtl \(20000ms\) to be at least WORKFLOW_CLAIM_TTL_SAFETY_MULTIPLIER \(3\) times workflowClaimRenewInterval \(10000ms\), i\.e\. at least 30000ms/,
    );
  });

  it('accepts workflowClaimTtl exactly at the WORKFLOW_CLAIM_TTL_SAFETY_MULTIPLIER floor', () => {
    const resolved = resolve({
      ownership: 'workflow-lease',
      workflowClaimTtl: '30s',
      workflowClaimRenewInterval: '10s',
    });

    expect(resolved.workflowClaimTtlMs).toBe(30_000);
    expect(resolved.workflowClaimRenewIntervalMs).toBe(10_000);
  });

  it("throws on a non-positive workflow-claim duration under ownership 'workflow-lease'", () => {
    // '0s' normalizes to 0ms — nonsensical for a claim; must be rejected before
    // the relationship checks run.
    expect(() => resolve({ ownership: 'workflow-lease', workflowClaimTtl: '0s' })).toThrow(
      /positive workflowClaimTtl/,
    );
  });

  it("rejects ownership 'workflow-lease' combined with detectSecondInstance: true", () => {
    expect(() => resolve({ ownership: 'workflow-lease', detectSecondInstance: true })).toThrow(
      /ownership: 'workflow-lease' cannot be combined with detectSecondInstance: true/,
    );
  });

  it("does not reject ownership 'workflow-lease' when detectSecondInstance is omitted or false", () => {
    expect(() => resolve({ ownership: 'workflow-lease' })).not.toThrow();
    expect(() =>
      resolve({ ownership: 'workflow-lease', detectSecondInstance: false }),
    ).not.toThrow();
  });
});

describe('resolveBackgroundTaskMode', () => {
  it("allows ownership 'workflow-lease' together with backgroundTasks: 'manual'", () => {
    // Unlike 'lease', 'workflow-lease' claim renewal is driven by
    // runMaintenance() on every awaited host tick — no process-local interval
    // is required, so this combination must NOT be rejected (ADR 0002).
    expect(
      resolveBackgroundTaskMode({ backgroundTasks: 'manual', ownership: 'workflow-lease' }),
    ).toBe('manual');
  });

  it("still rejects ownership 'lease' together with backgroundTasks: 'manual'", () => {
    expect(() =>
      resolveBackgroundTaskMode({ backgroundTasks: 'manual', ownership: 'lease' }),
    ).toThrow(/ownership cannot be "lease" when backgroundTasks is "manual"/);
  });
});

describe("ownership: 'workflow-lease' engine construction", () => {
  // This stage only widens and validates the option surface — no engine
  // behavior yet claims to fence per-workflow execution. Pin that: a
  // 'workflow-lease' engine must construct, recover, start, and complete a
  // workflow exactly as a 'none' engine would, with no throwing "not yet
  // wired" placeholder anywhere on that path.
  it('constructs, starts, and completes a workflow with no fencing behavior yet wired', async () => {
    const greet = workflow({ name: 'ownership-options-workflow-lease-smoke' }).execute(
      async function* (_ctx, input: { name: string }) {
        return `hello ${input.name}`;
      },
    );

    await using engine = await Engine.create({
      storage: new MemoryStorage(),
      ownership: 'workflow-lease',
      workflows: { 'ownership-options-workflow-lease-smoke': greet },
    });

    const handle = await engine.start('ownership-options-workflow-lease-smoke', {
      name: 'world',
    });
    expect(await handle.result()).toBe('hello world');
  });

  // KNOWN GAP for a later ADR 0002 stage to own, not this one: `getLeaseHealth()`
  // (src/core/engine/index.ts, the `internals.options.ownershipMode === 'none'`
  // check) has only two branches — 'none' and everything else falls through to
  // 'lease' reporting. A 'workflow-lease' engine therefore misreports
  // `mode: 'lease'` here rather than describing its own posture. This does not
  // throw, so it is not the banned "not yet wired" placeholder pattern, but it
  // is stale/misleading operator diagnostics that this stage's file-ownership
  // scope (index.ts is not among the files this stage owns) does not cover.
  it("getLeaseHealth() currently misreports mode: 'lease' under ownership: 'workflow-lease' (tracked gap)", async () => {
    await using engine = await Engine.create({
      storage: new MemoryStorage(),
      ownership: 'workflow-lease',
      workflows: {},
    });

    expect(engine.getLeaseHealth()).toEqual({
      mode: 'lease',
      status: 'no-lease',
      holdsLease: false,
    });
  });
});
