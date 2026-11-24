/**
 * The confirmation token every bulk operation shares names the runs it was previewed over, by
 * execution token as well as id and status: a stable id reused with `start-new` ends in the same
 * status, and a token that ignored the run would confirm an operation nobody previewed.
 */
import { describe, expect, it } from 'bun:test';

import { buildBulkOperationPreparation } from './bulk-operations-shared.ts';
import type { BulkWorkflowSnapshot } from './bulk-scanned-runs.ts';

function snapshot(workflowExecutionToken: string | undefined): BulkWorkflowSnapshot {
  return {
    id: 'order-1',
    type: 'order',
    status: 'completed',
    updatedAt: 1,
    ...(workflowExecutionToken === undefined ? {} : { workflowExecutionToken }),
  };
}

function tokenOver(snapshots: readonly BulkWorkflowSnapshot[], action: 'purge' | 'cancel') {
  return buildBulkOperationPreparation(action, {}, {}, snapshots, {}).confirmationToken;
}

describe('the bulk confirmation token', () => {
  for (const action of ['purge', 'cancel'] as const) {
    it(`differs for a run replaced under the same id and status (${action})`, () => {
      expect(tokenOver([snapshot('run-a')], action)).not.toBe(
        tokenOver([snapshot('run-b')], action),
      );
    });
  }

  it('is stable for the same run, and differs from a run stored before the token existed', () => {
    expect(tokenOver([snapshot('run-a')], 'purge')).toBe(tokenOver([snapshot('run-a')], 'purge'));
    expect(tokenOver([snapshot(undefined)], 'purge')).not.toBe(
      tokenOver([snapshot('run-a')], 'purge'),
    );
  });
});
