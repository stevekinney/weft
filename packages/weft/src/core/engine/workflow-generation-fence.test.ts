import { describe, expect, it } from 'bun:test';

import { KEYS } from '../../storage/interface.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { decodeGeneration, encodeGeneration } from './generation-codec.ts';
import {
  buildWorkflowGenerationBumpOperation,
  buildWorkflowGenerationBumpOperationForPurge,
  nextGenerationFromObservedBytes,
} from './workflow-generation-fence.ts';

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

  it('buildWorkflowGenerationBumpOperationForPurge reads the current value and bumps from it', async () => {
    const storage = new MemoryStorage();
    const workflowId = 'wf-purge-bump';

    // First purge of a never-used id: absent -> 1.
    const first = await buildWorkflowGenerationBumpOperationForPurge(
      { storage } as never,
      workflowId,
    );
    if (first.type !== 'put') throw new Error('expected a put operation');
    expect(decodeGeneration(first.value)).toBe(1);
    await storage.put(KEYS.workflowGeneration(workflowId), first.value);

    // A later purge of the SAME id (restart-and-purge-again) bumps again: 1 -> 2.
    const second = await buildWorkflowGenerationBumpOperationForPurge(
      { storage } as never,
      workflowId,
    );
    expect(second.type === 'put' && decodeGeneration(second.value)).toBe(2);
  });
});
