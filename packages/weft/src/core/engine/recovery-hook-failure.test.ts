/**
 * A recovery hook that throws fails the run it was called for, and when even that failure cannot be
 * written the run stays as it is and the engine reports a cleanup warning instead of rejecting
 * `recoverAll()`.
 */
import { describe, expect, it } from 'bun:test';

import { MemoryStorage } from "../../embedded/storage/src/index.ts";
import { KEYS } from '../../storage/keys.ts';
import { CleanupWarningEvent } from '../events.ts';
import { workflow, type WorkflowContext } from '../types.ts';
import { Engine } from './index.ts';
import { createRefusingStorage, putsWorkflowStatus } from './storage-write-refusal.test-support.ts';

const parked = workflow({ name: 'recovery-hook-parked' }).execute(async function* (
  ctx: WorkflowContext,
) {
  return yield* ctx.waitForSignal<string>('release');
});

describe('recoverAll() with a recovery hook that throws', () => {
  it('reports a cleanup warning when the run cannot be marked failed either', async () => {
    const base = new MemoryStorage();
    const refusing = createRefusingStorage(base);

    // A first engine leaves the run parked and durably running, as a crashed owner would.
    const previous = await Engine.create({
      storage: refusing.storage,
      workflows: { 'recovery-hook-parked': parked },
      recover: false,
    });
    await previous.start('recovery-hook-parked', null, { id: 'hooked-run' });
    await previous[Symbol.asyncDispose]();

    refusing.refuse({ matches: putsWorkflowStatus('hooked-run', 'failed') });
    refusing.arm();
    await using engine = await Engine.create({
      storage: refusing.storage,
      workflows: { 'recovery-hook-parked': parked },
      recover: false,
    });
    const warnings: CleanupWarningEvent[] = [];
    engine.addEventListener(CleanupWarningEvent.type, (event) => warnings.push(event));

    await engine.recoverAll({
      onRecoveredWorkflow: () => {
        throw new Error('hook exploded');
      },
    });

    expect(warnings.map(({ source, workflowId }) => [source, workflowId])).toEqual([
      ['onRecoveredWorkflow', 'hooked-run'],
    ]);
    expect(await base.get(KEYS.workflow('hooked-run'))).not.toBeNull();
  });
});
