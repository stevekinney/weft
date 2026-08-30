import { describe, expect, test } from 'bun:test';

import type { WorkflowStatus } from '@lostgradient/weft';

import {
  WORKFLOW_STATUS_ORDER,
  workflowStatusBadge,
  type WorkflowStatusBadgeTone,
} from './workflow-status-badge.ts';

describe('workflowStatusBadge', () => {
  const expected: Record<WorkflowStatus, { tone: WorkflowStatusBadgeTone; label: string }> = {
    running: { tone: 'success', label: 'Running' },
    pending: { tone: 'info', label: 'Pending' },
    suspended: { tone: 'warning', label: 'Suspended' },
    failed: { tone: 'danger', label: 'Failed' },
    'timed-out': { tone: 'danger', label: 'Timed out' },
    completed: { tone: 'neutral', label: 'Completed' },
    cancelled: { tone: 'neutral', label: 'Cancelled' },
  };

  for (const [status, spec] of Object.entries(expected) as [
    WorkflowStatus,
    { tone: WorkflowStatusBadgeTone; label: string },
  ][]) {
    test(`maps "${status}" to tone "${spec.tone}" and label "${spec.label}"`, () => {
      const badge = workflowStatusBadge(status);
      expect(badge.tone).toBe(spec.tone);
      expect(badge.label).toBe(spec.label);
      expect(badge.icon.length).toBeGreaterThan(0);
    });
  }

  test('WORKFLOW_STATUS_ORDER covers every WorkflowStatus exactly once', () => {
    expect(new Set(WORKFLOW_STATUS_ORDER).size).toBe(WORKFLOW_STATUS_ORDER.length);
    expect(WORKFLOW_STATUS_ORDER.toSorted()).toEqual(
      (Object.keys(expected) as WorkflowStatus[]).toSorted(),
    );
  });

  test('color is never the only signal — every spec carries a label and icon', () => {
    for (const status of WORKFLOW_STATUS_ORDER) {
      const badge = workflowStatusBadge(status);
      expect(badge.label.length).toBeGreaterThan(0);
      expect(badge.icon.length).toBeGreaterThan(0);
    }
  });
});
