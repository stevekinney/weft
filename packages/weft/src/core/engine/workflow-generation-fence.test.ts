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

  it('foldWorkflowGenerationBumpForPurge leaves an absent generation absent but still pins it (COR-1387)', async () => {
    // Absent means the id only ever ran under an engine-generated UUID: a purge
    // writes no row (so sustained generated-id load cannot grow storage), but
    // the condition on the absent value stays, so a concurrent explicit
    // `'start-new'` restart that writes the row still fences this purge out.
    const storage = new MemoryStorage();
    const workflowId = 'wf-purge-generated';
    const key = KEYS.workflowGeneration(workflowId);
    const baseOperation = { type: 'delete', key: 'unrelated' } as const;
    const baseCondition = { key: 'unrelated-condition', expectedValue: null };
    const base: WorkflowClaimTransitionFragment = {
      operations: [baseOperation],
      conditions: [baseCondition],
    };

    const result = await foldWorkflowGenerationBumpForPurge({ storage } as never, workflowId, base);
    expect(result.operations).toEqual([baseOperation]);
    expect(result.conditions).toEqual([baseCondition, { key, expectedValue: null }]);

    await storage.put(key, encodeGeneration(1));
    expect(await storage.conditionalBatch(result.conditions, result.operations)).toBe(false);
  });

  it('foldWorkflowGenerationBumpForPurge reads a present value, bumps from it, and folds into the base fragment', async () => {
    const storage = new MemoryStorage();
    const workflowId = 'wf-purge-bump';
    const key = KEYS.workflowGeneration(workflowId);
    const baseOperation = { type: 'delete', key: 'unrelated' } as const;
    const baseCondition = { key: 'unrelated-condition', expectedValue: null };
    const base: WorkflowClaimTransitionFragment = {
      operations: [baseOperation],
      conditions: [baseCondition],
    };
    // An explicit-id create wrote generation 1.
    await storage.put(key, encodeGeneration(1));

    // The base fragment's own operation/condition are preserved, with the bump
    // appended after them: 1 -> 2.
    const first = await foldWorkflowGenerationBumpForPurge({ storage } as never, workflowId, base);
    expect(first.operations).toEqual([
      baseOperation,
      { type: 'put', key, value: encodeGeneration(2) },
    ]);
    // MemoryStorage reports conditionalBatch: true, so the condition is present
    // and pins the pre-bump generation this read observed.
    expect(first.conditions).toEqual([baseCondition, { key, expectedValue: encodeGeneration(1) }]);
    const firstBump = first.operations.at(-1);
    if (firstBump === undefined || firstBump.type !== 'put') {
      throw new Error('expected a put operation');
    }
    await storage.put(key, firstBump.value);

    // A later purge of the SAME id (restart-and-purge-again) bumps again: 2 -> 3.
    const second = await foldWorkflowGenerationBumpForPurge({ storage } as never, workflowId, base);
    expect(second.operations).toEqual([
      baseOperation,
      { type: 'put', key, value: encodeGeneration(3) },
    ]);
    expect(second.conditions).toEqual([baseCondition, { key, expectedValue: firstBump.value }]);
  });

  it('foldWorkflowGenerationBumpForPurge omits the generation condition when the backend reports no conditionalBatch support', async () => {
    const storage = new MemoryStorage();
    const workflowId = 'wf-purge-bump-no-cas';
    await storage.put(KEYS.workflowGeneration(workflowId), encodeGeneration(1));
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
    expect(decodeGeneration(operation.value)).toBe(2);
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
    // The id was started with a caller-supplied id, whose create wrote generation 1.
    await storage.put(key, encodeGeneration(1));

    // Purge A and purge B both start against generation 1.
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

    // Purge B "wins the race" and commits first: 1 -> 2.
    const bCommitted = await storage.conditionalBatch(purgeB.conditions, purgeB.operations);
    expect(bCommitted).toBe(true);
    expect(decodeGeneration((await storage.get(key))!)).toBe(2);

    // The id is reused and purged again (a third purge), advancing generation
    // 2 -> 3, observing the CURRENT value B just wrote.
    const purgeC = await foldWorkflowGenerationBumpForPurge(
      { storage } as never,
      workflowId,
      EMPTY_FRAGMENT,
    );
    const cCommitted = await storage.conditionalBatch(purgeC.conditions, purgeC.operations);
    expect(cCommitted).toBe(true);
    expect(decodeGeneration((await storage.get(key))!)).toBe(3);

    // The delayed original purge A now finally attempts its commit, built from
    // its STALE generation-1 read (predating both B and C). Its CAS condition
    // no longer matches the current value (encode(3)), so the commit must be
    // REJECTED rather than overwrite generation 3 with A's stale generation 2.
    const aCommitted = await storage.conditionalBatch(purgeA.conditions, purgeA.operations);
    expect(aCommitted).toBe(false);
    expect(decodeGeneration((await storage.get(key))!)).toBe(3);
  });
});
