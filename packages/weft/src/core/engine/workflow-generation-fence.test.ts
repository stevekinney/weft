import { describe, expect, it } from 'bun:test';

import { KEYS } from '../../storage/interface.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { decodeGeneration, encodeGeneration } from './generation-codec.ts';
import type { WorkflowClaimTransitionFragment } from './workflow-claim-transitions.ts';
import {
  buildWorkflowGenerationBumpOperation,
  foldWorkflowGenerationBumpForPurge,
  nextGenerationFromObservedBytes,
} from './workflow-generation-fence.ts';

const EMPTY_FRAGMENT: WorkflowClaimTransitionFragment = { operations: [], conditions: [] };

describe('workflow-generation-fence (WFT-153)', () => {
  it('mints generation 1 when nothing was observed (absent)', () => {
    expect(nextGenerationFromObservedBytes(null)).toBe(1);
  });

  it('mints observed + 1 when a valid generation was observed', () => {
    expect(nextGenerationFromObservedBytes(encodeGeneration(5))).toBe(6);
  });

  it('mints generation 1 when the observed bytes are malformed (cannot decode)', () => {
    // Wrong byte length: `decodeGeneration` returns `null`, treated the same as
    // absent rather than propagating the corruption into an arbitrary bump.
    expect(nextGenerationFromObservedBytes(new Uint8Array([1, 2, 3]))).toBe(1);
  });

  it('buildWorkflowGenerationBumpOperation builds a PUT at KEYS.workflowGeneration encoding the bumped value', () => {
    const operation = buildWorkflowGenerationBumpOperation('wf-1', encodeGeneration(2));
    expect(operation.type).toBe('put');
    expect(operation.key).toBe(KEYS.workflowGeneration('wf-1'));
    expect(operation.type === 'put' && decodeGeneration(operation.value)).toBe(3);
  });

  it('foldWorkflowGenerationBumpForPurge reads the current value, bumps from it, and folds into the base fragment', async () => {
    const storage = new MemoryStorage();
    const workflowId = 'wf-purge-bump';
    const key = KEYS.workflowGeneration(workflowId);
    const baseOperation = { type: 'delete', key: 'unrelated' } as const;
    const baseCondition = { key: 'unrelated-condition', expectedValue: null };
    const base: WorkflowClaimTransitionFragment = {
      operations: [baseOperation],
      conditions: [baseCondition],
    };

    // First purge of a never-used id: absent -> 1. The base fragment's own
    // operation/condition are preserved, with the bump appended after them.
    const first = await foldWorkflowGenerationBumpForPurge({ storage } as never, workflowId, base);
    expect(first.operations).toEqual([
      baseOperation,
      { type: 'put', key, value: encodeGeneration(1) },
    ]);
    // MemoryStorage reports conditionalBatch: true, so the condition is present
    // and pins the pre-bump (absent) generation this read observed.
    expect(first.conditions).toEqual([baseCondition, { key, expectedValue: null }]);
    const firstBump = first.operations.at(-1);
    if (firstBump === undefined || firstBump.type !== 'put') {
      throw new Error('expected a put operation');
    }
    await storage.put(key, firstBump.value);

    // A later purge of the SAME id (restart-and-purge-again) bumps again: 1 -> 2.
    const second = await foldWorkflowGenerationBumpForPurge({ storage } as never, workflowId, base);
    expect(second.operations).toEqual([
      baseOperation,
      { type: 'put', key, value: encodeGeneration(2) },
    ]);
    expect(second.conditions).toEqual([baseCondition, { key, expectedValue: firstBump.value }]);
  });

  it('foldWorkflowGenerationBumpForPurge omits the generation condition when the backend reports no conditionalBatch support', async () => {
    const storage = new MemoryStorage();
    const workflowId = 'wf-purge-bump-no-cas';
    const capabilities = storage.capabilities();
    // A minimal object carrying only what this function reads (`get` and
    // `capabilities`), rather than spreading the `MemoryStorage` class
    // instance — spreading a class instance loses its prototype methods.
    const degraded = {
      get: (key: string) => storage.get(key),
      capabilities: () => ({ ...capabilities, conditionalBatch: false }),
    };

    const result = await foldWorkflowGenerationBumpForPurge(
      { storage: degraded } as never,
      workflowId,
      EMPTY_FRAGMENT,
    );
    expect(result.conditions).toEqual([]);
    const operation = result.operations[0];
    if (operation === undefined || operation.type !== 'put') {
      throw new Error('expected a put operation');
    }
    expect(decodeGeneration(operation.value)).toBe(1);
  });

  it('never regresses the generation counter across two overlapping purges of the same id (WFT-153 review)', async () => {
    // Two standalone purges of the same id can overlap under `ownership: 'none'`:
    // both read the same generation before either commits. Before this fix, both
    // built an UNCONDITIONED bump from that shared read, so whichever committed
    // LAST always won — including a delayed, stale purge overwriting a newer
    // generation written by an intervening third purge of the same reused id.
    // The CAS condition folded in now must make the delayed/stale commit lose
    // its race instead of rolling the counter backward.
    const storage = new MemoryStorage();
    const workflowId = 'wf-overlapping-purge';
    const key = KEYS.workflowGeneration(workflowId);

    // Purge A and purge B both start against generation "absent" (id never used).
    const purgeA = await foldWorkflowGenerationBumpForPurge(
      { storage } as never,
      workflowId,
      EMPTY_FRAGMENT,
    );
    const purgeB = await foldWorkflowGenerationBumpForPurge(
      { storage } as never,
      workflowId,
      EMPTY_FRAGMENT,
    );

    // Purge B "wins the race" and commits first: absent -> 1.
    const bCommitted = await storage.conditionalBatch(purgeB.conditions, purgeB.operations);
    expect(bCommitted).toBe(true);
    expect(decodeGeneration((await storage.get(key))!)).toBe(1);

    // The id is reused and purged again (a third purge), advancing generation
    // 1 -> 2, observing the CURRENT value B just wrote.
    const purgeC = await foldWorkflowGenerationBumpForPurge(
      { storage } as never,
      workflowId,
      EMPTY_FRAGMENT,
    );
    const cCommitted = await storage.conditionalBatch(purgeC.conditions, purgeC.operations);
    expect(cCommitted).toBe(true);
    expect(decodeGeneration((await storage.get(key))!)).toBe(2);

    // The delayed original purge A now finally attempts its commit, built from
    // its STALE "absent" read (predating both B and C). Its CAS condition
    // (`expectedValue: null`) no longer matches the current value (encode(2)),
    // so the commit must be REJECTED rather than overwrite generation 2 with A's
    // stale generation 1.
    const aCommitted = await storage.conditionalBatch(purgeA.conditions, purgeA.operations);
    expect(aCommitted).toBe(false);
    expect(decodeGeneration((await storage.get(key))!)).toBe(2);
  });
});
