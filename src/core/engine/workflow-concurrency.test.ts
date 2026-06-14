import { describe, expect, it } from 'bun:test';

import { TestEngine } from '../../testing/test-engine.ts';
import { workflow, type WorkflowContext } from '../types.ts';
import { WorkflowConcurrencyLimitExceededError } from './errors.ts';

async function* waitForRelease(
  ctx: WorkflowContext,
  input: { value: string },
): AsyncGenerator<unknown, string, unknown> {
  const releaseValue = yield* ctx.waitForSignal<string>('release');
  return `${input.value}:${releaseValue}`;
}

describe('workflow definition concurrency', () => {
  it('rejects excess starts immediately for a workflow-wide limit', async () => {
    await using engine = new TestEngine({ startTime: 1_000 });
    engine.register(
      workflow({ name: 'limited-global', concurrency: { max: 1 } }).execute(waitForRelease),
    );

    const first = await engine.start('limited-global', { value: 'first' });

    await expect(engine.start('limited-global', { value: 'second' })).rejects.toMatchObject({
      code: 'WorkflowConcurrencyLimitExceededError',
      workflowType: 'limited-global',
      limit: 1,
      partitionKey: 'limited-global',
    });

    try {
      await engine.start('limited-global', { value: 'third' });
    } catch (error) {
      expect(error).toBeInstanceOf(WorkflowConcurrencyLimitExceededError);
      expect(error).toHaveProperty('partitionKey', 'limited-global');
    }

    await engine.signal(first.id, 'release', 'done');
    await expect(first.result()).resolves.toBe('first:done');

    const second = await engine.start('limited-global', { value: 'second' });
    await engine.signal(second.id, 'release', 'done');
    await expect(second.result()).resolves.toBe('second:done');
  });

  it('limits starts independently per user-defined partition key', async () => {
    await using engine = new TestEngine({ startTime: 1_000 });
    engine.register(
      workflow({
        name: 'limited-by-customer',
        concurrency: {
          max: 1,
          key: (input) => (input as { customerId: string }).customerId,
        },
      }).execute(async function* (ctx: WorkflowContext, input: { customerId: string }) {
        const releaseValue = yield* ctx.waitForSignal<string>('release');
        return `${input.customerId}:${releaseValue}`;
      }),
    );

    const firstAlpha = await engine.start('limited-by-customer', { customerId: 'alpha' });
    const firstBeta = await engine.start('limited-by-customer', { customerId: 'beta' });

    await expect(
      engine.start('limited-by-customer', { customerId: 'alpha' }),
    ).rejects.toMatchObject({
      code: 'WorkflowConcurrencyLimitExceededError',
      workflowType: 'limited-by-customer',
      limit: 1,
      partitionKey: 'alpha',
    });

    await engine.signal(firstAlpha.id, 'release', 'done');
    await expect(firstAlpha.result()).resolves.toBe('alpha:done');

    const secondAlpha = await engine.start('limited-by-customer', { customerId: 'alpha' });

    await engine.signal(firstBeta.id, 'release', 'done');
    await engine.signal(secondAlpha.id, 'release', 'done');
    await expect(firstBeta.result()).resolves.toBe('beta:done');
    await expect(secondAlpha.result()).resolves.toBe('alpha:done');
  });

  it('does not consume another slot for a duplicate idempotent start', async () => {
    await using engine = new TestEngine({ startTime: 1_000 });
    engine.register(
      workflow({ name: 'limited-idempotent', concurrency: { max: 1 } }).execute(waitForRelease),
    );

    const first = await engine.start(
      'limited-idempotent',
      { value: 'first' },
      { idempotencyKey: 'same-key' },
    );
    const duplicate = await engine.start(
      'limited-idempotent',
      { value: 'ignored' },
      { idempotencyKey: 'same-key' },
    );

    expect(duplicate.id).toBe(first.id);
    await expect(
      engine.start('limited-idempotent', { value: 'second' }, { idempotencyKey: 'other-key' }),
    ).rejects.toBeInstanceOf(WorkflowConcurrencyLimitExceededError);

    await engine.signal(first.id, 'release', 'done');
    await expect(first.result()).resolves.toBe('first:done');
  });

  it('releases a recovered running workflow slot when that workflow completes', async () => {
    const original = new TestEngine({ startTime: 1_000 });
    original.register(
      workflow({ name: 'limited-recovered', concurrency: { max: 1 } }).execute(waitForRelease),
    );
    const originalHandle = await original.start('limited-recovered', { value: 'first' });

    const recovered = original.recover();
    original[Symbol.dispose]();
    await using disposableRecovered = recovered;
    disposableRecovered.register(
      workflow({ name: 'limited-recovered', concurrency: { max: 1 } }).execute(waitForRelease),
    );

    const [recoveredHandle] = await disposableRecovered.recoverAll();
    expect(recoveredHandle?.id).toBe(originalHandle.id);

    await disposableRecovered.signal(originalHandle.id, 'release', 'done');
    await expect(recoveredHandle?.result()).resolves.toBe('first:done');

    const next = await disposableRecovered.start('limited-recovered', { value: 'second' });
    await disposableRecovered.signal(next.id, 'release', 'done');
    await expect(next.result()).resolves.toBe('second:done');
  });
});
