import { describe, expect, it, mock } from 'bun:test';

import {
  mergeSessionStateRunOptions,
  stateSession,
  type SessionStateRunArguments,
} from './context/session-state.ts';

import {
  assertValidSessionStateKey,
  createSessionStateStore,
  MAX_SESSION_STATE_ENTRY_COUNT,
  MAX_SESSION_STATE_KEY_LENGTH,
  MAX_SESSION_STATE_SERIALIZED_BYTES,
  normalizeSessionStateRecord,
  SessionStateValidationError,
  validateSessionStateStore,
} from './session-state.ts';

describe('session-state helpers', () => {
  it('rejects empty and oversized keys', () => {
    expect(() => assertValidSessionStateKey('')).toThrow(SessionStateValidationError);
    expect(() => assertValidSessionStateKey('x'.repeat(MAX_SESSION_STATE_KEY_LENGTH + 1))).toThrow(
      /1-256 characters long/,
    );
  });

  it('rejects reserved keys', () => {
    expect(() => assertValidSessionStateKey('__proto__')).toThrow(/is reserved/);
  });

  it('normalizes undefined and empty records to undefined', () => {
    expect(normalizeSessionStateRecord(undefined)).toBeUndefined();
    expect(normalizeSessionStateRecord({})).toBeUndefined();
  });

  it('rejects records with too many entries during normalization', () => {
    const oversized = Object.fromEntries(
      Array.from({ length: MAX_SESSION_STATE_ENTRY_COUNT + 1 }, (_value, index) => [
        `key-${String(index)}`,
        index,
      ]),
    );

    expect(() => normalizeSessionStateRecord(oversized)).toThrow(
      `Session state may not contain more than ${String(MAX_SESSION_STATE_ENTRY_COUNT)} keys.`,
    );
  });

  it('rejects stores with too many entries during validation', () => {
    const store = createSessionStateStore();
    for (let index = 0; index <= MAX_SESSION_STATE_ENTRY_COUNT; index += 1) {
      store[`key-${String(index)}`] = index;
    }

    expect(() => validateSessionStateStore(store)).toThrow(
      `Session state may not contain more than ${String(MAX_SESSION_STATE_ENTRY_COUNT)} keys.`,
    );
  });

  it('rejects stores whose serialized form exceeds the size limit', () => {
    const store = createSessionStateStore();
    store['large'] = 'x'.repeat(MAX_SESSION_STATE_SERIALIZED_BYTES);

    expect(() => validateSessionStateStore(store)).toThrow(
      `Session state exceeds the ${String(MAX_SESSION_STATE_SERIALIZED_BYTES)} byte limit.`,
    );
  });

  it('merges session-state run arguments across empty, input, and options forms', () => {
    expect(mergeSessionStateRunOptions([])).toEqual({
      hasInput: false,
      options: { sticky: true },
    } satisfies SessionStateRunArguments);
    expect(mergeSessionStateRunOptions([{ queue: 'emails' }])).toEqual({
      hasInput: false,
      options: { queue: 'emails', sticky: true },
    } satisfies SessionStateRunArguments);
    expect(mergeSessionStateRunOptions(['payload'])).toEqual({
      hasInput: true,
      input: 'payload',
      options: { sticky: true },
    } satisfies SessionStateRunArguments);
    expect(mergeSessionStateRunOptions(['payload', { retry: { maxAttempts: 3 } }])).toEqual({
      hasInput: true,
      input: 'payload',
      options: { retry: { maxAttempts: 3 }, sticky: true },
    } satisfies SessionStateRunArguments);
  });

  it('rejects invalid session-state run argument shapes', () => {
    expect(() => mergeSessionStateRunOptions([1, 2, 3])).toThrow(
      'sessionState.run() accepts one activity input value plus optional ActivityCallOptions.',
    );
    expect(() => mergeSessionStateRunOptions(['payload', { not: 'options' }])).toThrow(
      'sessionState.run() options must be ActivityCallOptions.',
    );
  });

  it('supports numeric, object, array, delete, and run helpers', () => {
    const run = mock((...args: unknown[]) => args);
    const stateSessionInternals = {
      accumulatedResults: undefined,
      checkpointLocals: undefined,
      stateSession: undefined,
      stepIndex: 0,
    };

    const counterSession = stateSession(
      { run } as never,
      stateSessionInternals as never,
      'counter',
      { initial: 10 },
    );
    expect(counterSession.increment()).toBe(11);
    expect(counterSession.decrement(2)).toBe(9);

    const objectSession = stateSession({ run } as never, stateSessionInternals as never, 'object', {
      initial: { name: 'Ada', role: 'viewer' },
    });
    expect(objectSession.merge({ role: 'admin' })).toEqual({ name: 'Ada', role: 'admin' });

    const arraySession = stateSession({ run } as never, stateSessionInternals as never, 'items', {
      initial: ['first'],
    });
    expect(arraySession.append('second')).toEqual(['first', 'second']);
    expect(arraySession.removeFirst()).toBe('first');
    expect(arraySession.removeLast()).toBe('second');
    expect(arraySession.removeLast()).toBeUndefined();

    const deleteSession = stateSession(
      { run } as never,
      stateSessionInternals as never,
      'delete-me',
      { initial: 'value' },
    );
    deleteSession.set('value');
    deleteSession.delete();
    deleteSession.delete();
    expect(deleteSession.get()).toBe('value');

    const runSession = stateSession({ run } as never, stateSessionInternals as never, 'run');
    const operationWithoutInput = runSession.run(() => 'done') as unknown as unknown[];
    const operationWithInput = runSession.run((input) => input, 'payload', {
      queue: 'default',
    }) as unknown as unknown[];

    expect(operationWithoutInput).toEqual([expect.any(Function), { sticky: true }]);
    expect(operationWithInput).toEqual([
      expect.any(Function),
      'payload',
      { queue: 'default', sticky: true },
    ]);
  });
});
