import { ExtData, encode as msgpackEncode } from '@msgpack/msgpack';
import { describe, expect, it } from 'bun:test';

import { KEYS } from '../../storage/interface.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { waitForCondition } from '../../testing/fake-timers.test-support.ts';
import { workflow, type WorkflowContext } from '../types.ts';
import { CURRENT_CHECKPOINT_SCHEMA_VERSION } from '../types/checkpoint.ts';
import { Engine } from './index.ts';

const REGEXP_EXTENSION_TYPE = 2;

function encodeCheckpointWithInvalidRegExp(workflowId: string): Uint8Array {
  return msgpackEncode({
    workflowId,
    step: 1,
    locals: {
      pattern: new ExtData(REGEXP_EXTENSION_TYPE, msgpackEncode({ source: 'hello', flags: 'z' })),
    },
    accumulatedResults: [],
    searchAttributes: {},
    version: '1.0.0',
    schemaVersion: CURRENT_CHECKPOINT_SCHEMA_VERSION,
    createdAt: 1_778_716_800_000,
  });
}

async function waitForCheckpoint(storage: MemoryStorage, workflowId: string): Promise<void> {
  await waitForCondition(async () => (await storage.get(KEYS.checkpoint(workflowId))) !== null, {
    label: `checkpoint for ${workflowId}`,
  });
}

describe('checkpoint decode failures during recovery', () => {
  it('fails only the workflow whose checkpoint contains an invalid RegExp extension', async () => {
    const storage = new MemoryStorage();
    const waitingWorkflow = workflow({ name: 'checkpoint-decode-waiter' }).execute(async function* (
      ctx: WorkflowContext,
    ) {
      yield* ctx.waitForSignal('continue');
      return 'resumed';
    });

    {
      await using original = new Engine({ storage });
      original.register(waitingWorkflow);
      await original.start('checkpoint-decode-waiter', null, { id: 'corrupt-checkpoint' });
      await original.start('checkpoint-decode-waiter', null, { id: 'healthy-checkpoint' });
      await waitForCheckpoint(storage, 'corrupt-checkpoint');
      await waitForCheckpoint(storage, 'healthy-checkpoint');
    }

    await storage.put(
      KEYS.checkpoint('corrupt-checkpoint'),
      encodeCheckpointWithInvalidRegExp('corrupt-checkpoint'),
    );

    await using recovered = new Engine({ storage });
    recovered.register(waitingWorkflow);

    const handles = await recovered.recoverAll();

    expect(handles.map((handle) => handle.id)).toEqual(['healthy-checkpoint']);
    const corruptSummary = await recovered.get('corrupt-checkpoint');
    expect(corruptSummary?.status).toBe('failed');
    expect(corruptSummary?.error).toContain('RegExp extension type 2');

    const healthyHandle = handles[0]!;
    await healthyHandle.signal('continue');
    await expect(healthyHandle.result()).resolves.toBe('resumed');
  });
});
