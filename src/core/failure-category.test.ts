import { sleepForTesting } from '../testing/fake-timers.ts';
/**
 * Tests for WorkflowState.failureCategory — populated on all failed workflows
 * and indexed so it can be queried via engine.list({ attributes: ... }).
 */

import { afterEach, describe, expect, it } from 'bun:test';

import { Engine } from './engine.ts';
import type { FailureCategory } from './types.ts';

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

    engine.register('crash', async function* () {
      throw new Error('intentional failure');
    });

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
    engine.register('timeout-crash', async function* () {
      throw new ReviewTimeoutError();
    });

    const handle = await engine.start('timeout-crash', null, { id: 'wf-timeout-fail' });
    await expect(handle.result()).rejects.toThrow('review timed out');

    const state = await engine.get('wf-timeout-fail');
    expect(state?.failureCategory).toBe('timeout');
  });

  it('sets failureCategory to "cancellation" for abort-shaped errors', async () => {
    engine = new Engine();
    engine.register('abort-crash', async function* () {
      throw new DOMException('operation aborted', 'AbortError');
    });

    const handle = await engine.start('abort-crash', null, { id: 'wf-cancellation-fail' });
    await expect(handle.result()).rejects.toThrow('operation aborted');

    const state = await engine.get('wf-cancellation-fail');
    expect(state?.failureCategory).toBe('cancellation');
  });

  it('sets failureCategory to "resource" for quota-shaped errors', async () => {
    class QuotaExceededError extends Error {
      constructor() {
        super('tenant quota exceeded');
        this.name = 'QuotaExceededError';
      }
    }

    engine = new Engine();
    engine.register('quota-crash', async function* () {
      throw new QuotaExceededError();
    });

    const handle = await engine.start('quota-crash', null, { id: 'wf-resource-fail' });
    await expect(handle.result()).rejects.toThrow('tenant quota exceeded');

    const state = await engine.get('wf-resource-fail');
    expect(state?.failureCategory).toBe('resource');
  });

  it('failureCategory is null when a workflow has not yet failed', async () => {
    engine = new Engine();

    const { promise: blocker, resolve } = Promise.withResolvers<void>();

    engine.register('long-running', async function* () {
      await blocker;
      return 'done';
    });

    const handle = await engine.start('long-running', null, { id: 'wf-running' });
    handle.result().catch(() => {});

    await flush();

    const state = await engine.get('wf-running');
    expect(state?.status).toBe('running');
    expect(state?.failureCategory).toBeUndefined();

    resolve();
    await handle.result();
  });
});

describe('failureCategory search attribute indexing', () => {
  let engine: Engine;

  afterEach(() => {
    engine[Symbol.dispose]();
  });

  it('engine.list({ attributes: [{ key: "failureCategory", value: "application" }] }) returns failed workflow', async () => {
    engine = new Engine();

    engine.register('crash-a', async function* () {
      throw new Error('system failure a');
    });

    engine.register('crash-b', async function* () {
      throw new Error('system failure b');
    });

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

    engine.register('succeed', async function* () {
      return 'done';
    });

    engine.register('crash', async function* () {
      throw new Error('failure');
    });

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
});
