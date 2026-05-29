import { describe, expect, it } from 'bun:test';

import { activity } from './activity.ts';
import type { ActivityContext, ActivityDefinition } from './types.ts';
import { activity as createConfiguredActivity } from './types.ts';

describe('activity()', () => {
  it('wraps a metadata definition as a callable activity', () => {
    const definition: ActivityDefinition<string, string> = {
      name: 'greet',
      execute: (input: string) => `Hello, ${input}!`,
    };

    const result = activity(definition);
    expect(result.name).toBe('greet');
    expect(result.execute).toBe(definition.execute);
    expect(result).not.toBe(definition);
  });

  it('preserves all fields including retry, timeout, queue, and idempotent', () => {
    const definition: ActivityDefinition<number, number> = {
      name: 'compute',
      execute: (input: number) => input * 2,
      retry: {
        maxAttempts: 5,
        initialBackoff: 500,
        backoffMultiplier: 1.5,
        maxBackoff: 10_000,
        nonRetryableErrors: ['ValidationError'],
      },
      timeout: '30 seconds',
      queue: 'high-priority',
      idempotent: true,
    };

    const result = activity(definition);

    expect(result.name).toBe('compute');
    expect(result.execute).toBe(definition.execute);
    expect(result.retry).toEqual(definition.retry);
    expect(result.timeout).toBe('30 seconds');
    expect(result.queue).toBe('high-priority');
    expect(result.idempotent).toBe(true);
  });

  it('preserves the execute function behavior', () => {
    const definition: ActivityDefinition<string, string> = {
      name: 'echo',
      execute: (input: string) => input.toUpperCase(),
    };

    const result = activity(definition);
    expect(result.execute('hello')).toBe('HELLO');
  });

  it('types.activity returns a callable function with colocated configuration', async () => {
    const sendEmail = createConfiguredActivity({
      name: 'send-email',
      queue: 'priority',
      execute: async (input: string) => `sent:${input}`,
    });

    expect(await sendEmail('welcome')).toBe('sent:welcome');
    expect(sendEmail.name).toBe('send-email');
    expect(sendEmail.queue).toBe('priority');
    expect(sendEmail.execute).toBeDefined();
  });

  it('forwards ActivityContext when the configured activity is called directly', async () => {
    let receivedContext: ActivityContext | undefined;
    const context: ActivityContext = {
      signal: new AbortController().signal,
      heartbeat: () => {},
      completeAsync: (): never => {
        throw new Error('completeAsync should not be called in this test');
      },
    };

    const recordHeartbeat = createConfiguredActivity({
      name: 'record-heartbeat',
      execute: async (_input: string, activityContext?: ActivityContext) => {
        receivedContext = activityContext;
        activityContext?.heartbeat({ progress: 1 });
        return 'recorded';
      },
    });

    expect(await recordHeartbeat('start', context)).toBe('recorded');
    expect(receivedContext).toBe(context);
  });

  it('accepts a named function directly and derives the activity name from it', async () => {
    const uppercase = createConfiguredActivity(async function uppercase(input: string) {
      return input.toUpperCase();
    });

    expect(uppercase.name).toBe('uppercase');
    expect(await uppercase('hello')).toBe('HELLO');
  });

  it('rejects unnamed activities created from either branch', () => {
    expect(() =>
      createConfiguredActivity(async function (input: string) {
        return input;
      }),
    ).toThrow('activity() requires a named function or an options object with name.');

    expect(() =>
      createConfiguredActivity({
        name: '',
        execute: (input: string) => input,
      }),
    ).toThrow('activity() requires a named function or an options object with name.');
  });
});
