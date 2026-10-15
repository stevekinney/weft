import { describe, expect, it } from 'bun:test';

import type { WorkflowResultWaiter } from './engine-internal-types.ts';
import { HANDLE_RESULT_SETTLEMENT } from './handles.ts';
import {
  copyResultCommitter,
  readHandleResultCommitter,
  recordResultCommitter,
} from './result-committer.ts';

function createWaiter(): WorkflowResultWaiter {
  const { promise, resolve, reject } = Promise.withResolvers<unknown>();
  return { promise, resolve, reject };
}

function handleSettledWith(waiter: WorkflowResultWaiter) {
  return { id: 'workflow-id', [HANDLE_RESULT_SETTLEMENT]: () => waiter.promise };
}

describe('result committer', () => {
  it('records a non-empty engine id and keeps the first one recorded', () => {
    const waiter = createWaiter();
    recordResultCommitter(waiter, 'engine-b');
    recordResultCommitter(waiter, 'engine-a');

    expect(readHandleResultCommitter(handleSettledWith(waiter))).toBe('engine-b');
  });

  it('ignores a malformed stamp read back from a decoded terminal record', () => {
    for (const malformed of [undefined, null, '', 42, { engineId: 'engine-b' }]) {
      const waiter = createWaiter();
      recordResultCommitter(waiter, malformed);

      expect(readHandleResultCommitter(handleSettledWith(waiter))).toBeUndefined();
    }
  });

  it('lets a valid stamp land after a malformed one was ignored', () => {
    const waiter = createWaiter();
    recordResultCommitter(waiter, null);
    recordResultCommitter(waiter, 'engine-b');

    expect(readHandleResultCommitter(handleSettledWith(waiter))).toBe('engine-b');
  });

  it('copies a recorded committer to a linked waiter', () => {
    const source = createWaiter();
    const linked = createWaiter();
    recordResultCommitter(source, 'engine-b');
    copyResultCommitter(source, linked);

    expect(readHandleResultCommitter(handleSettledWith(linked))).toBe('engine-b');
  });
});
