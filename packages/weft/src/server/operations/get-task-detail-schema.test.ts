import { describe, expect, it } from 'bun:test';

import { getTaskDetailOutputSchema } from './get-task-detail.ts';

describe('getTaskDetailOutputSchema', () => {
  const terminalBase = {
    operationId: 'op-1',
    workflowType: 'test',
    activityName: 'charge',
    queue: 'default',
    headerKeys: [],
    visibilityTimeoutMilliseconds: 30_000,
    createdAt: 1_000,
    attempt: 1,
    // COR-205: every state's envelope requires an attempt-history array.
    attempts: [],
    state: 'terminal' as const,
    terminalAt: 4_000,
    adopted: false,
  };

  it('accepts a resolved terminal record with resultDigest and resultStatus', () => {
    const result = getTaskDetailOutputSchema.safeParse({
      ...terminalBase,
      disposition: 'resolved',
      resultDigest: 'digest-abc',
      resultStatus: 'completed',
    });
    expect(result.success).toBe(true);
  });

  it('rejects a cancelled terminal record with no cancellationReason — the durable union requires one', () => {
    const result = getTaskDetailOutputSchema.safeParse({
      ...terminalBase,
      disposition: 'cancelled',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a retryExhausted terminal record with no error — the durable union requires one', () => {
    const result = getTaskDetailOutputSchema.safeParse({
      ...terminalBase,
      disposition: 'retryExhausted',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a cancelled terminal record carrying resultStatus or resultDigest — those belong only to resolved', () => {
    const result = getTaskDetailOutputSchema.safeParse({
      ...terminalBase,
      disposition: 'cancelled',
      cancellationReason: 'operator requested',
      resultStatus: 'completed',
    });
    expect(result.success).toBe(false);
  });

  it('accepts a terminal record with no retryCount/requeueCount — RemoteTaskTerminal never carries attempt-count history', () => {
    const result = getTaskDetailOutputSchema.safeParse({
      ...terminalBase,
      disposition: 'resolved',
      resultDigest: 'digest-abc',
      resultStatus: 'completed',
    });
    expect(result.success).toBe(true);
  });

  const nonterminalBase = {
    operationId: 'op-1',
    workflowType: 'test',
    activityName: 'charge',
    queue: 'default',
    headerKeys: [],
    visibilityTimeoutMilliseconds: 30_000,
    createdAt: 1_000,
    attempt: 1,
    // COR-205: every state's envelope requires an attempt-history array.
    attempts: [],
    state: 'queued' as const,
    availableAt: 1_000,
    firstQueuedAt: 1_000,
    lastQueuedAt: 1_000,
  };

  it('rejects a queued record missing retryCount/requeueCount — RemoteTaskAttemptFields guarantees both on every nonterminal state', () => {
    const result = getTaskDetailOutputSchema.safeParse(nonterminalBase);
    expect(result.success).toBe(false);
  });

  it('accepts a queued record with retryCount/requeueCount present', () => {
    const result = getTaskDetailOutputSchema.safeParse({
      ...nonterminalBase,
      retryCount: 0,
      requeueCount: 0,
    });
    expect(result.success).toBe(true);
  });
});
