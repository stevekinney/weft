import { describe, expect, it, spyOn } from 'bun:test';

import { KEYS } from '../../storage/interface.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { Engine } from '../engine.ts';
import {
  bootstrapWorkflowResultResolver,
  createWorkflowHandleWithResultPromise,
  createWorkflowResultWaiter,
} from './handle-result.ts';
import { getInternals } from './internals.ts';

class WorkflowStateReadFailureStorage extends MemoryStorage {
  constructor(private readonly failingWorkflowId: string) {
    super();
  }

  override async get(key: string): Promise<Uint8Array | null> {
    if (key === KEYS.workflow(this.failingWorkflowId)) {
      throw new Error(`failed to read ${this.failingWorkflowId}`);
    }
    return super.get(key);
  }
}

describe('workflow result resolution', () => {
  it('rejects the waiter when loading workflow state throws', async () => {
    await using engine = new Engine({
      storage: new WorkflowStateReadFailureStorage('wf-state-read-failure'),
    });
    const internals = getInternals(engine);
    const waiter = createWorkflowResultWaiter(internals, 'wf-state-read-failure');

    await bootstrapWorkflowResultResolver(internals, 'wf-state-read-failure', waiter);

    await expect(waiter.promise).rejects.toThrow('failed to read wf-state-read-failure');
    expect(internals.resultResolvers.has('wf-state-read-failure')).toBe(false);
  });

  it('links a replacement waiter to the current waiter promise', async () => {
    await using engine = new Engine({ storage: new MemoryStorage() });
    const internals = getInternals(engine);
    const currentWaiter = createWorkflowResultWaiter(internals, 'wf-replacement');
    const { promise, resolve, reject } = Promise.withResolvers<unknown>();
    const replacementWaiter = { promise, resolve, reject };

    await bootstrapWorkflowResultResolver(internals, 'wf-replacement', replacementWaiter);
    currentWaiter.resolve('resolved through replacement');

    await expect(replacementWaiter.promise).resolves.toBe('resolved through replacement');
  });

  it('unregisters the previous cached handle token before replacing it', async () => {
    await using engine = new Engine({ storage: new MemoryStorage() });
    const internals = getInternals(engine);
    const unregisterSpy = spyOn(internals.finalizationRegistry, 'unregister');

    const firstHandle = createWorkflowHandleWithResultPromise(internals, 'wf-cache');
    const firstCachedEntry = internals.handleCache.get('wf-cache');
    const secondHandle = createWorkflowHandleWithResultPromise(internals, 'wf-cache');

    expect(firstHandle.id).toBe('wf-cache');
    expect(secondHandle.id).toBe('wf-cache');
    expect(firstCachedEntry).toBeDefined();
    expect(unregisterSpy).toHaveBeenCalledTimes(1);
    expect(unregisterSpy).toHaveBeenCalledWith(firstCachedEntry!.unregisterToken);
  });
});
