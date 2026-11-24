/**
 * `isolateRecoveryFailure` treats a `WorkflowNotResumableError` as recovered elsewhere only when
 * the status it carries is terminal (COR-1593). A status a resume cannot continue that is not
 * terminal still aborts the batch, so the isolation hides nothing but a run another drive ended.
 */
import { describe, expect, it } from 'bun:test';

import type { WorkflowStatus } from '../../types.ts';
import { isolateRecoveryFailure } from './recovery-isolation.ts';
import { WorkflowNotResumableError } from './workflow-not-resumable-error.ts';

// Neither branch under test commits a failure write, so any callback read is a defect.
const untouchedCallbacks = new Proxy(
  {},
  {
    get: (_target, key) => {
      throw new Error(`isolateRecoveryFailure read the "${String(key)}" callback`);
    },
  },
) as never;

describe('isolateRecoveryFailure and a run a resume cannot continue', () => {
  const terminalStatuses: WorkflowStatus[] = ['completed', 'failed', 'cancelled', 'timed-out'];

  for (const status of terminalStatuses) {
    it(`isolates a run whose status became "${status}"`, async () => {
      const error = new WorkflowNotResumableError('ended-elsewhere', status);
      expect(
        await isolateRecoveryFailure('ended-elsewhere', untouchedCallbacks, undefined, error),
      ).toBeNull();
    });
  }

  it('rethrows for a status that is not terminal', async () => {
    const error = new WorkflowNotResumableError('still-pending', 'pending');
    let thrown: unknown;
    try {
      await isolateRecoveryFailure('still-pending', untouchedCallbacks, undefined, error);
    } catch (caught) {
      thrown = caught;
    }
    expect(thrown).toBe(error);
  });
});
