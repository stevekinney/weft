import { describe, expect, it } from 'bun:test';

import { MemoryStorage } from '../../storage/memory.ts';
import { sleepForTesting } from '../../testing/fake-timers.test-support.ts';
import { Engine } from '../engine.ts';
import { PayloadSizeExceededError } from '../payload-size.ts';
import { workflow, type WorkflowContext } from '../types.ts';
import { bufferSignalPayloads, type SignalCallbacks } from './signals.ts';

async function flush(): Promise<void> {
  await sleepForTesting(10);
}

const signalPrefix = (workflowId: string): string => `sig:${workflowId}:`;

// A workflow that parks waiting for a signal so the signal write path is live.
const waiterWorkflow = workflow({ name: 'waiter' }).execute(async function* (ctx: WorkflowContext) {
  return yield* ctx.waitForSignal('release');
});

async function countSignalKeys(storage: MemoryStorage, workflowId: string): Promise<number> {
  let count = 0;
  for await (const _key of storage.keys(signalPrefix(workflowId))) {
    count += 1;
  }
  return count;
}

describe('payload-size cap — signal payload', () => {
  it('rejects an oversize signal payload before writing any signal key', async () => {
    const storage = new MemoryStorage();
    const engine = new Engine({ storage, payloadSize: { maxBytes: 64 } });
    engine.register(waiterWorkflow);

    const handle = await engine.start('waiter', null, { id: 'wf-signal' });
    handle.result().catch(() => {});
    await flush();

    const oversize = 'x'.repeat(1024);
    let thrown: unknown;
    try {
      await engine.signal('wf-signal', 'release', oversize);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(PayloadSizeExceededError);
    expect((thrown as PayloadSizeExceededError).payloadKind).toBe('signal payload');
    expect(await countSignalKeys(storage, 'wf-signal')).toBe(0);

    engine[Symbol.dispose]();
  });

  it('admits a signal payload at or below the limit', async () => {
    const storage = new MemoryStorage();
    const engine = new Engine({ storage, payloadSize: { maxBytes: 1024 } });
    engine.register(waiterWorkflow);

    const handle = await engine.start('waiter', null, { id: 'wf-signal-ok' });
    const resultPromise = handle.result();
    await flush();

    await engine.signal('wf-signal-ok', 'release', 'ping');
    await flush();

    expect(await resultPromise).toBe('ping');

    engine[Symbol.dispose]();
  });

  it('aborts the whole buffered batch when any one payload is oversize (nothing written)', async () => {
    const storage = new MemoryStorage();
    const internals = {
      options: { payloadSizePolicy: { maxBytes: 64 } },
      parkedInlineWorkflows: new Set<string>(),
      signalWaiters: new Map<string, () => void>(),
      signalWaitersByWorkflow: new Map(),
      conditionWaiters: new Map<string, () => void>(),
      storage,
      workflowsNeedingTerminalCleanup: new Set<string>(),
    };
    const callbacks: SignalCallbacks = {
      broadcast: () => {},
      dispatchEvent: () => true,
      getComposedInterceptor: () => null,
      loadWorkflowState: async () => null,
      resumeParkedInlineWorkflow: async () => {},
    };

    await expect(
      bufferSignalPayloads(
        internals as never,
        'wf-batch',
        [
          { signalName: 'a', payload: 'small' },
          { signalName: 'b', payload: 'x'.repeat(1024) },
        ],
        callbacks,
      ),
    ).rejects.toBeInstanceOf(PayloadSizeExceededError);

    // The small delivery that preceded the oversize one was not written either.
    expect(await countSignalKeys(storage, 'wf-batch')).toBe(0);
  });
});
