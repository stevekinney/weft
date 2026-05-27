import { describe, expect, it } from 'bun:test';
import { sleepForTesting } from '../testing/fake-timers.test-support.ts';
import type { ActivityExecutionRequest, ActivityExecutionResult } from './activity-runner.ts';
import { executeActivity } from './activity-runner.ts';

describe('executeActivity', () => {
  it('returns completed for a successful synchronous function', async () => {
    const request: ActivityExecutionRequest = {
      operationId: 'op-1',
      activityName: 'greet',
      input: 'world',
      attempt: 1,
    };

    const result = await executeActivity(request, (input: unknown) => `hello ${String(input)}`);

    expect(result).toEqual({
      operationId: 'op-1',
      status: 'completed',
      value: 'hello world',
    } satisfies ActivityExecutionResult);
  });

  it('returns completed for a successful async function', async () => {
    const request: ActivityExecutionRequest = {
      operationId: 'op-2',
      activityName: 'asyncGreet',
      input: 42,
      attempt: 1,
    };

    const result = await executeActivity(request, async (input: unknown) => {
      await sleepForTesting(1);
      return (input as number) * 2;
    });

    expect(result).toEqual({
      operationId: 'op-2',
      status: 'completed',
      value: 84,
    } satisfies ActivityExecutionResult);
  });

  it('returns failed with error message when function throws', async () => {
    const request: ActivityExecutionRequest = {
      operationId: 'op-3',
      activityName: 'failingActivity',
      input: null,
      attempt: 1,
    };

    const result = await executeActivity(request, () => {
      throw new Error('something broke');
    });

    expect(result.operationId).toBe('op-3');
    expect(result.status).toBe('failed');
    expect(result.error).toContain('something broke');
  });

  it('returns failed with error message when async function rejects', async () => {
    const request: ActivityExecutionRequest = {
      operationId: 'op-4',
      activityName: 'asyncFailing',
      input: null,
      attempt: 1,
    };

    const result = await executeActivity(request, async () => {
      throw new Error('async failure');
    });

    expect(result.operationId).toBe('op-4');
    expect(result.status).toBe('failed');
    expect(result.error).toContain('async failure');
  });

  it('captures non-Error throws as strings', async () => {
    const request: ActivityExecutionRequest = {
      operationId: 'op-5',
      activityName: 'stringThrower',
      input: null,
      attempt: 1,
    };

    const result = await executeActivity(request, () => {
      throw 'raw string error';
    });

    expect(result.status).toBe('failed');
    expect(result.error).toContain('raw string error');
  });

  it('respects an already-aborted AbortSignal', async () => {
    const request: ActivityExecutionRequest = {
      operationId: 'op-6',
      activityName: 'abortable',
      input: null,
      attempt: 1,
    };

    const controller = new AbortController();
    controller.abort('cancelled by test');

    const result = await executeActivity(request, () => 'should not reach', controller.signal);

    expect(result.operationId).toBe('op-6');
    expect(result.status).toBe('failed');
    expect(result.error).toContain('aborted');
  });

  it('includes activity name in error for context', async () => {
    const request: ActivityExecutionRequest = {
      operationId: 'op-7',
      activityName: 'processPayment',
      input: null,
      attempt: 3,
    };

    const result = await executeActivity(request, () => {
      throw new Error('timeout');
    });

    expect(result.status).toBe('failed');
    expect(result.error).toContain('processPayment');
  });

  it('returns undefined value when function returns void', async () => {
    const request: ActivityExecutionRequest = {
      operationId: 'op-8',
      activityName: 'sideEffect',
      input: null,
      attempt: 1,
    };

    const result = await executeActivity(request, () => {
      // side effect only, no return
    });

    expect(result.status).toBe('completed');
    expect(result.value).toBeUndefined();
  });
});
