import { sleepForTesting } from '../testing/fake-timers.test-support.ts';
/**
 * Tests for WorkflowState.failureCategory — populated on all failed workflows
 * and indexed so it can be queried via engine.list({ attributes: ... }).
 */

import { afterEach, describe, expect, it } from 'bun:test';

import { KEYS } from '../storage/interface.ts';
import { MemoryStorage } from '../storage/memory.ts';
import { encode } from './codec/api.ts';
import { Engine } from './engine.ts';
import { classifyErrorAsFailureCategory } from './failure-categories.ts';
import { buildIndexOperations as buildSearchAttributeIndexOperations } from './search-attributes.ts';
import type { FailureCategory } from './types.ts';
import { workflow } from './types.ts';

/** Drain microtasks so fire-and-forget work completes. */
async function flush(): Promise<void> {
  await sleepForTesting(10);
}

describe('failureCategory on WorkflowState', () => {
  let engine: Engine;

  afterEach(() => {
    engine[Symbol.dispose]();
  });

  it('sets failureCategory to "application" when workflow code throws', async () => {
    engine = new Engine();

    const crashWorkflow = workflow({ name: 'crash' }).execute(async function* () {
      throw new Error('intentional failure');
    });
    engine.register(crashWorkflow);

    const handle = await engine.start('crash', null, { id: 'wf-system-fail' });

    try {
      await handle.result();
    } catch {
      // expected
    }

    const state = await engine.get('wf-system-fail');
    expect(state?.status).toBe('failed');
    expect(state?.failureCategory).toBe('application');
  });

  it('sets failureCategory to "timeout" for timeout-shaped errors', async () => {
    class ReviewTimeoutError extends Error {
      constructor() {
        super('review timed out');
        this.name = 'ReviewTimeoutError';
      }
    }

    engine = new Engine();
    const timeoutCrashWorkflow = workflow({ name: 'timeout-crash' }).execute(async function* () {
      throw new ReviewTimeoutError();
    });
    engine.register(timeoutCrashWorkflow);

    const handle = await engine.start('timeout-crash', null, { id: 'wf-timeout-fail' });
    await expect(handle.result()).rejects.toThrow('review timed out');

    const state = await engine.get('wf-timeout-fail');
    expect(state?.failureCategory).toBe('timeout');
  });

  it('sets failureCategory to "cancellation" for abort-shaped errors', async () => {
    engine = new Engine();
    const abortCrashWorkflow = workflow({ name: 'abort-crash' }).execute(async function* () {
      throw new DOMException('operation aborted', 'AbortError');
    });
    engine.register(abortCrashWorkflow);

    const handle = await engine.start('abort-crash', null, { id: 'wf-cancellation-fail' });
    await expect(handle.result()).rejects.toThrow('operation aborted');

    const state = await engine.get('wf-cancellation-fail');
    expect(state?.failureCategory).toBe('cancellation');
  });

  it('sets failureCategory to "resource" for resource-exhaustion-shaped errors', async () => {
    class ResourceExhaustedError extends Error {
      constructor() {
        super('resource exhausted');
        this.name = 'ResourceExhaustedError';
      }
    }

    engine = new Engine();
    const resourceCrashWorkflow = workflow({ name: 'resource-crash' }).execute(async function* () {
      throw new ResourceExhaustedError();
    });
    engine.register(resourceCrashWorkflow);

    const handle = await engine.start('resource-crash', null, { id: 'wf-resource-fail' });
    await expect(handle.result()).rejects.toThrow('resource exhausted');

    const state = await engine.get('wf-resource-fail');
    expect(state?.failureCategory).toBe('resource');
  });

  it('failureCategory is null when a workflow has not yet failed', async () => {
    engine = new Engine();

    const { promise: blocker, resolve } = Promise.withResolvers<void>();

    const longRunningWorkflow = workflow({ name: 'long-running' }).execute(async function* () {
      await blocker;
      return 'done';
    });
    engine.register(longRunningWorkflow);

    const handle = await engine.start('long-running', null, { id: 'wf-running' });
    handle.result().catch(() => {});

    await flush();

    const state = await engine.get('wf-running');
    expect(state?.status).toBe('running');
    expect(state?.failureCategory).toBeUndefined();

    resolve();
    await handle.result();
  });

  it('classifies non-Error values as system failures at runtime boundaries', () => {
    expect(classifyErrorAsFailureCategory('string failure')).toBe('system');
  });
});

describe('failureCategory search attribute indexing', () => {
  let engine: Engine;

  afterEach(() => {
    engine[Symbol.dispose]();
  });

  it('engine.list({ attributes: [{ key: "failureCategory", value: "application" }] }) returns failed workflow', async () => {
    engine = new Engine();

    const crashAWorkflow = workflow({ name: 'crash-a' }).execute(async function* () {
      throw new Error('system failure a');
    });
    engine.register(crashAWorkflow);

    const crashBWorkflow = workflow({ name: 'crash-b' }).execute(async function* () {
      throw new Error('system failure b');
    });
    engine.register(crashBWorkflow);

    const handleA = await engine.start('crash-a', null, { id: 'wf-cat-a' });
    const handleB = await engine.start('crash-b', null, { id: 'wf-cat-b' });

    try {
      await handleA.result();
    } catch {
      // expected
    }
    try {
      await handleB.result();
    } catch {
      // expected
    }

    const result = await engine.list({
      attributes: [{ key: 'failureCategory', value: 'application' as FailureCategory }],
    });

    expect(result.items.length).toBe(2);
    const ids = result.items.map((item) => item.id);
    expect(ids).toContain('wf-cat-a');
    expect(ids).toContain('wf-cat-b');
  });

  it('engine.list({ attributes: [{ key: "failureCategory", value: "application" }] }) does not return completed workflows', async () => {
    engine = new Engine();

    const succeedWorkflow = workflow({ name: 'succeed' }).execute(async function* () {
      return 'done';
    });
    engine.register(succeedWorkflow);

    const crashWorkflow2 = workflow({ name: 'crash' }).execute(async function* () {
      throw new Error('failure');
    });
    engine.register(crashWorkflow2);

    const successHandle = await engine.start('succeed', null, { id: 'wf-success' });
    const failHandle = await engine.start('crash', null, { id: 'wf-fail' });

    await successHandle.result();
    try {
      await failHandle.result();
    } catch {
      // expected
    }

    const result = await engine.list({
      attributes: [{ key: 'failureCategory', value: 'application' as FailureCategory }],
    });

    expect(result.items.length).toBe(1);
    expect(result.items[0]!.id).toBe('wf-fail');
  });

  it('engine.list({ attributes: [{ key: "failureCategory", value: "application" }] }) matches legacy indexed categories', async () => {
    const storage = new MemoryStorage();
    engine = new Engine({ storage });
    const workflowId = 'wf-legacy-planning-index';

    await storage.put(
      KEYS.workflow(workflowId),
      encode({
        id: workflowId,
        type: 'legacy',
        status: 'failed',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        input: null,
        output: undefined,
        error: 'legacy planning failure',
        failureCategory: null,
        tags: [],
      }),
    );
    await storage.put(KEYS.attribute(workflowId), encode({ failureCategory: 'planning' }));
    await storage.batch(
      buildSearchAttributeIndexOperations(workflowId, {}, { failureCategory: 'planning' }),
    );

    const result = await engine.list(
      {
        attributes: [{ key: 'failureCategory', value: 'application' as FailureCategory }],
      },
      { includeFailureCategory: true },
    );

    expect(result.items.map((item) => item.id)).toEqual([workflowId]);
    expect(result.items[0]?.failureCategory).toBe('application');
  });
});
