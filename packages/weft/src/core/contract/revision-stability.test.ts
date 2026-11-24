/**
 * Pins the revision and contract hash of a representative workflow that does
 * not use `.uses()`. Dynamic workflow sources persist a descriptor revision
 * and running instances pin the revision they started under, so a change to
 * the canonical contract that moved these values for existing content would
 * make those sources unloadable and strand their runs. A contract addition
 * must leave a definition that does not populate it byte-identical.
 */
import { describe, expect, it } from 'bun:test';

import { z } from 'zod';
import { deriveWorkflowDefinitionRevision } from '../engine/definition-revision.ts';
import { activity, query, signal, update, workflow } from '../types.ts';
import { buildWorkflowContract } from './build.ts';
import { contractHash } from './hash.ts';
import { deriveWorkflowRevision } from './revision.ts';

const representative = workflow({
  name: 'checkout',
  version: '2.1.0',
  description: 'Charge a cart and confirm the order.',
  tags: ['billing', 'orders'],
  inputSchema: z.object({ cartId: z.string() }),
  outputSchema: z.object({ orderId: z.string() }),
})
  .activities({
    charge: activity({
      name: 'charge',
      inputSchema: z.object({ amount: z.number() }),
      outputSchema: z.string(),
      description: 'Charge the card on file.',
      timeout: '30s',
      tags: ['payments'],
      idempotent: true,
      execute: async () => 'charge-1',
    }),
  })
  .signals({ approve: signal<{ approverId: string }>('approve') })
  .updates({ rename: update<string, string>('rename') })
  .queries({ progress: query<void, number>('progress') })
  .execute(async function* () {
    return { orderId: 'order-1' };
  });

const GOLDEN_REVISION = 'sha256:f63702b9680935d263df5d36e4f00af754911ae8f7ae71db60ea547810bb61ac';
const GOLDEN_CONTRACT_HASH =
  'sha256:eee533083fbc8c9250062e50a461ceee518083c19d5a056c2a5a2ce0c75b5cab';

describe('revision stability for workflows that do not use .uses()', () => {
  it('keeps the contract-built revision and contract hash', async () => {
    const contract = buildWorkflowContract(representative);
    expect(await deriveWorkflowRevision(contract)).toBe(GOLDEN_REVISION);
    expect(await contractHash(contract)).toBe(GOLDEN_CONTRACT_HASH);
  });

  it('keeps the revision the registration path derives for a dynamic source', async () => {
    expect(await deriveWorkflowDefinitionRevision(representative)).toBe(GOLDEN_REVISION);
  });
});
