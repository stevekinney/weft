import { afterEach, describe, expect, it } from 'bun:test';

import { ActivityMockRegistry } from './mocks';

interface EmailInput {
  to: string;
  body: string;
}

async function sendEmail(input: EmailInput): Promise<string> {
  return `sent to ${input.to}: ${input.body}`;
}

async function processPayment(amount: number): Promise<{ id: string }> {
  return { id: `pay-${amount}` };
}

describe('ActivityMockRegistry', () => {
  let registry: ActivityMockRegistry;

  afterEach(() => {
    registry?.restoreAll();
  });

  it('registers a mock so has() returns true', () => {
    registry = new ActivityMockRegistry();
    registry.mock(sendEmail, async () => 'mocked');
    expect(registry.has(sendEmail)).toBe(true);
  });

  it('calls the mock implementation when executed', async () => {
    registry = new ActivityMockRegistry();
    const handle = registry.mock(sendEmail, async (_input) => 'fake-result');

    const mocked = registry.get(sendEmail);
    const result = await mocked!.implementation({ to: 'alice@test.com', body: 'hello' });
    expect(result).toBe('fake-result');
    expect(handle.callCount).toBe(1);
  });

  it('records all invocations with input', async () => {
    registry = new ActivityMockRegistry();
    const handle = registry.mock(sendEmail, async () => 'ok');

    const mocked = registry.get(sendEmail)!;
    await mocked.implementation({ to: 'a@test.com', body: 'first' });
    await mocked.implementation({ to: 'b@test.com', body: 'second' });

    expect(handle.calls).toHaveLength(2);
    expect(handle.calls[0]!.input).toEqual({ to: 'a@test.com', body: 'first' });
    expect(handle.calls[1]!.input).toEqual({ to: 'b@test.com', body: 'second' });
  });

  it('records results in call history', async () => {
    registry = new ActivityMockRegistry();
    const handle = registry.mock(sendEmail, async () => 'result-value');

    const mocked = registry.get(sendEmail)!;
    await mocked.implementation({ to: 'a@test.com', body: 'hi' });

    expect(handle.calls[0]!.result).toBe('result-value');
    expect(handle.calls[0]!.error).toBeUndefined();
  });

  it('returns the correct callCount', async () => {
    registry = new ActivityMockRegistry();
    const handle = registry.mock(sendEmail, async () => 'ok');

    const mocked = registry.get(sendEmail)!;
    await mocked.implementation({ to: 'a', body: 'b' });
    await mocked.implementation({ to: 'c', body: 'd' });
    await mocked.implementation({ to: 'e', body: 'f' });

    expect(handle.callCount).toBe(3);
  });

  it('returns the most recent call via lastCall', async () => {
    registry = new ActivityMockRegistry();
    const handle = registry.mock(sendEmail, async () => 'ok');

    expect(handle.lastCall).toBeUndefined();

    const mocked = registry.get(sendEmail)!;
    await mocked.implementation({ to: 'first@test.com', body: 'a' });
    await mocked.implementation({ to: 'last@test.com', body: 'b' });

    expect(handle.lastCall!.input).toEqual({ to: 'last@test.com', body: 'b' });
  });

  it('replaces the implementation via mockImplementation', async () => {
    registry = new ActivityMockRegistry();
    const handle = registry.mock(sendEmail, async () => 'original');

    const mocked = registry.get(sendEmail)!;
    const firstResult = await mocked.implementation({ to: 'a', body: 'b' });
    expect(firstResult).toBe('original');

    handle.mockImplementation(async () => 'replaced');
    const secondResult = await mocked.implementation({ to: 'a', body: 'b' });
    expect(secondResult).toBe('replaced');
  });

  it('returns a value once with mockReturnValueOnce then falls back', async () => {
    registry = new ActivityMockRegistry();
    const handle = registry.mock(sendEmail, async () => 'default');

    handle.mockReturnValueOnce('once-value');

    const mocked = registry.get(sendEmail)!;
    const first = await mocked.implementation({ to: 'a', body: 'b' });
    const second = await mocked.implementation({ to: 'a', body: 'b' });

    expect(first).toBe('once-value');
    expect(second).toBe('default');
  });

  it('rejects once with mockRejectionOnce then succeeds', async () => {
    registry = new ActivityMockRegistry();
    const handle = registry.mock(sendEmail, async () => 'default');

    handle.mockRejectionOnce(new Error('boom'));

    const mocked = registry.get(sendEmail)!;

    let thrownError: Error | undefined;
    try {
      await (mocked.implementation({ to: 'a', body: 'b' }) as Promise<unknown>);
    } catch (error) {
      thrownError = error as Error;
    }
    expect(thrownError).toBeDefined();
    expect(thrownError!.message).toBe('boom');

    const second = await mocked.implementation({ to: 'a', body: 'b' });
    expect(second).toBe('default');
  });

  it('clears call history with resetCalls', async () => {
    registry = new ActivityMockRegistry();
    const handle = registry.mock(sendEmail, async () => 'ok');

    const mocked = registry.get(sendEmail)!;
    await mocked.implementation({ to: 'a', body: 'b' });
    expect(handle.callCount).toBe(1);

    handle.resetCalls();
    expect(handle.callCount).toBe(0);
    expect(handle.calls).toHaveLength(0);
    expect(handle.lastCall).toBeUndefined();
  });

  it('removes a mock with restore so has() returns false', async () => {
    registry = new ActivityMockRegistry();
    const handle = registry.mock(sendEmail, async () => 'ok');

    expect(registry.has(sendEmail)).toBe(true);
    handle.restore();
    expect(registry.has(sendEmail)).toBe(false);
  });

  it('removes all mocks with restoreAll', () => {
    registry = new ActivityMockRegistry();
    registry.mock(sendEmail, async () => 'ok');
    registry.mock(processPayment, async () => ({ id: 'mock' }));

    expect(registry.has(sendEmail)).toBe(true);
    expect(registry.has(processPayment)).toBe(true);

    registry.restoreAll();

    expect(registry.has(sendEmail)).toBe(false);
    expect(registry.has(processPayment)).toBe(false);
  });

  it('works with async mock implementations', async () => {
    registry = new ActivityMockRegistry();
    const handle = registry.mock(processPayment, async (amount) => {
      await Promise.resolve();
      return { id: `mock-${amount}` };
    });

    const mocked = registry.get(processPayment)!;
    const result = await mocked.implementation(500);

    expect(result).toEqual({ id: 'mock-500' });
    expect(handle.callCount).toBe(1);
    expect(handle.calls[0]!.result).toEqual({ id: 'mock-500' });
  });
});
