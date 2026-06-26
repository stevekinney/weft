import { describe, expect, it, spyOn } from 'bun:test';

import { Context } from '../context.ts';
import { getVersion, review, sleep } from './durable-operations.ts';
import { getInternals } from './internals.ts';

function createContext(overrides: Partial<ConstructorParameters<typeof Context>[0]> = {}) {
  return new Context({
    workflowId: 'wf-durable-sleep',
    workflowType: 'durable-sleep-test',
    startedAt: 1000,
    abortController: new AbortController(),
    ...overrides,
  });
}

describe('durable operation helpers', () => {
  it('yields the prepared sleep request and caches the completion step', () => {
    const context = createContext({ getNow: () => 5_000 });
    const internals = getInternals(context);

    const generator = sleep(context, internals, '1s');
    const first = generator.next();

    expect(first.done).toBe(false);
    expect(first.value).toMatchObject({
      type: 'sleep',
      duration: 1_000,
      scheduledFireAt: 6_000,
    });

    const completed = generator.next();
    expect(completed.done).toBe(true);
    expect(context.accumulatedResults.has(0)).toBe(true);
    expect(context.accumulatedResults.get(0)).toBeUndefined();
  });

  it('returns immediately when the step result is already cached', () => {
    const context = createContext({ accumulatedResults: new Map([[0, undefined]]) });
    const internals = getInternals(context);

    const generator = sleep(context, internals, '1s');
    const result = generator.next();

    expect(result.done).toBe(true);
    expect(result.value).toBeUndefined();
  });

  it('returns a cached review result without yielding again', () => {
    const cachedReviewResult = {
      decision: 'approved' as const,
      reviewId: 'review-1',
      reviewer: 'reviewer-1',
      timestamp: 123,
    };
    const context = createContext({ accumulatedResults: new Map([[0, cachedReviewResult]]) });
    const internals = getInternals(context);

    const generator = review(context, internals, { reviewType: 'approval' } as any);
    const result = generator.next();

    expect(result.done).toBe(true);
    expect(result.value).toEqual(cachedReviewResult);
  });

  it('logs explain-mode review details before yielding the wait-review request', () => {
    using log = spyOn(console, 'log').mockImplementation(() => {});
    const context = createContext();
    const internals = getInternals(context);
    internals.explainMode = true;

    const generator = review(context, internals, { reviewType: 'approval' } as any);
    const first = generator.next();

    expect(first.done).toBe(false);
    expect(first.value).toMatchObject({ type: 'wait-review' });
    expect(log).toHaveBeenCalledWith('[weft] ctx.review("approval")');
    expect(log).toHaveBeenCalledWith('  → Creating checkpoint at step 0');
    expect(log).toHaveBeenCalledWith('  → Pausing for human review');
  });

  it('fails loudly when a cached getVersion replay result disagrees with the pinned version', () => {
    const context = createContext({
      accumulatedResults: new Map([[0, 1]]),
    });
    const internals = getInternals(context);

    const generator = getVersion(context, internals, 'shipping-v2', 1, 2);

    expect(() => generator.next()).toThrow(
      'ctx.getVersion("shipping-v2") replay result 1 does not match pinned version 2',
    );
  });

  it('logs explain-mode getVersion details before yielding the pinned version request', () => {
    using log = spyOn(console, 'log').mockImplementation(() => {});
    const context = createContext();
    const internals = getInternals(context);
    internals.explainMode = true;

    const generator = getVersion(context, internals, 'shipping-v2', 1, 2);
    const first = generator.next();

    expect(first.done).toBe(false);
    expect(first.value).toMatchObject({
      type: 'get-version',
      changeId: 'shipping-v2',
      minSupported: 1,
      maxSupported: 2,
      version: 2,
    });
    expect(log).toHaveBeenCalledWith('[weft] ctx.getVersion("shipping-v2", 1, 2)');
    expect(log).toHaveBeenCalledWith('  → Creating checkpoint at step 0');
    expect(log).toHaveBeenCalledWith('  → Pinning workflow patch "shipping-v2" to version 2');
  });
});
