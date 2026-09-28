import { describe, expect, it } from 'bun:test';

import {
  RealmEnvelopeMismatchError,
  validateRealmTurnEnvelope,
  type RealmTurnEnvelope,
} from './realm-protocol.ts';

function envelope(overrides: Partial<RealmTurnEnvelope> = {}): RealmTurnEnvelope {
  return {
    workflowRevision: 'revision-a',
    realmGeneration: 'generation-1',
    executionToken: 'token-1',
    turnId: 1,
    ...overrides,
  };
}

describe('validateRealmTurnEnvelope', () => {
  it('accepts an envelope that matches on every field', () => {
    const expected = envelope();
    const received = envelope();
    expect(validateRealmTurnEnvelope(expected, received)).toEqual({ ok: true });
  });

  it('rejects a wrong workflowRevision', () => {
    const expected = envelope();
    const received = envelope({ workflowRevision: 'revision-b' });
    expect(validateRealmTurnEnvelope(expected, received)).toEqual({
      ok: false,
      mismatch: 'workflowRevision',
      expected: 'revision-a',
      received: 'revision-b',
    });
  });

  it('rejects a wrong realmGeneration', () => {
    const expected = envelope();
    const received = envelope({ realmGeneration: 'generation-2' });
    expect(validateRealmTurnEnvelope(expected, received)).toEqual({
      ok: false,
      mismatch: 'realmGeneration',
      expected: 'generation-1',
      received: 'generation-2',
    });
  });

  it('rejects a wrong executionToken', () => {
    const expected = envelope();
    const received = envelope({ executionToken: 'token-2' });
    expect(validateRealmTurnEnvelope(expected, received)).toEqual({
      ok: false,
      mismatch: 'executionToken',
      expected: 'token-1',
      received: 'token-2',
    });
  });

  it('rejects a wrong turnId', () => {
    const expected = envelope();
    const received = envelope({ turnId: 2 });
    expect(validateRealmTurnEnvelope(expected, received)).toEqual({
      ok: false,
      mismatch: 'turnId',
      expected: 1,
      received: 2,
    });
  });

  it('reports mismatches in a fixed, deterministic order when several fields disagree', () => {
    const expected = envelope();
    const received = envelope({ realmGeneration: 'generation-2', turnId: 2 });
    const validation = validateRealmTurnEnvelope(expected, received);
    expect(validation.ok).toBe(false);
    expect(!validation.ok && validation.mismatch).toBe('realmGeneration');
  });
});

describe('RealmEnvelopeMismatchError', () => {
  it('names the mismatched field and both values in its message', () => {
    const expected = envelope();
    const received = envelope({ turnId: 7 });
    const validation = validateRealmTurnEnvelope(expected, received);
    if (validation.ok) throw new Error('expected a mismatch');

    const error = new RealmEnvelopeMismatchError(validation);
    expect(error.name).toBe('RealmEnvelopeMismatchError');
    expect(error.message).toContain('turnId');
    expect(error.message).toContain('1');
    expect(error.message).toContain('7');
    expect(error.validation).toBe(validation);
  });
});
