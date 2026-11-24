import { describe, expect, it } from 'bun:test';

import { WorkflowCatalogConflictError, WorkflowRevisionTombstonedError } from './errors.ts';
import {
  failureReason,
  hostFailure,
  stoppedError,
  WorkflowRefreshError,
} from './workflow-refresh-failure.ts';

describe('failureReason', () => {
  it('keeps the reason of an error the coordinator already typed, whatever else is true', () => {
    const typed = new WorkflowRefreshError('integrity', 'bad bytes');

    expect(failureReason(typed, AbortSignal.abort(), true)).toBe('integrity');
  });

  it('reports a stopped coordinator ahead of any other cause', () => {
    expect(failureReason(new WorkflowCatalogConflictError('checkout', 'r1'), undefined, true)).toBe(
      'stopped',
    );
  });

  it('reports a catalog conflict or a tombstoned revision as a conflict', () => {
    expect(
      failureReason(new WorkflowCatalogConflictError('checkout', 'r1'), undefined, false),
    ).toBe('conflict');
    expect(
      failureReason(new WorkflowRevisionTombstonedError('checkout', 'r1'), undefined, false),
    ).toBe('conflict');
  });

  it('reports a caller whose signal aborted as cancelled', () => {
    expect(failureReason(new Error('aborted'), AbortSignal.abort(), false)).toBe('cancelled');
  });

  it('reports anything else as internal, with or without a live caller signal', () => {
    expect(failureReason(new Error('disk full'), undefined, false)).toBe('internal');
    expect(failureReason('not even an error', new AbortController().signal, false)).toBe(
      'internal',
    );
  });
});

describe('hostFailure and stoppedError', () => {
  it('wraps a host error with its message as the cause and passes typed errors and cancellations through', () => {
    const hostError = new Error('fetch failed');
    const wrapped = hostFailure('source', hostError, new AbortController().signal);

    expect(wrapped).toBeInstanceOf(WorkflowRefreshError);
    expect((wrapped as WorkflowRefreshError).reason).toBe('source');
    expect((wrapped as WorkflowRefreshError).message).toBe('fetch failed');
    expect((wrapped as WorkflowRefreshError).cause).toBe(hostError);

    const typed = new WorkflowRefreshError('contract', 'bad manifest');
    expect(hostFailure('source', typed, new AbortController().signal)).toBe(typed);
    expect(hostFailure('source', hostError, AbortSignal.abort())).toBe(hostError);
    expect(
      (hostFailure('source', 'plain text', new AbortController().signal) as Error).message,
    ).toBe('plain text');
    expect(stoppedError().reason).toBe('stopped');
  });
});
