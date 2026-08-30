import { fireEvent, render, waitFor } from '@testing-library/svelte';
import { describe, expect, test } from 'bun:test';

import type { WorkflowState, WorkflowTimelineEntry } from '@lostgradient/weft';
import { QueryClient } from '@tanstack/svelte-query';

import type { FleetEventFrame } from '../../../lib/live-source/fleet-event-source.svelte.ts';
import TimelineTabHarness from './timeline-tab.test-harness.svelte';
import { WorkflowLiveObservations } from './timeline/workflow-live-observations.svelte.ts';

class InertFleet {
  caughtUp = false;

  subscribe(_onFrame: (frame: FleetEventFrame) => void): () => void {
    return () => {};
  }
}

function workflow(id: string): WorkflowState {
  return {
    id,
    type: 'trip-booking-saga',
    status: 'running',
    input: {},
    versionTuple: { workflowVersion: '1' },
    createdAt: 1_000,
    updatedAt: 1_000,
  };
}

function entries(length: number, failedCount = 0): WorkflowTimelineEntry[] {
  return Array.from({ length }, (_, index) => ({
    step: index + 1,
    operationType: 'activity',
    operationLabel: `step-${index + 1}`,
    inputSummary: '{}',
    timestamp: 1_000,
    status: index < failedCount ? 'failed' : 'completed',
  }));
}

function renderTimeline(id: string, timeline: WorkflowTimelineEntry[]) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const liveObservations = new WorkflowLiveObservations(new InertFleet(), queryClient, id);
  return render(TimelineTabHarness, {
    props: {
      client: {
        getTimeline: async () => timeline,
        operations: {
          'weft.workflows.activities.pending.list': async () => ({ items: [] }),
        },
        activity: {
          complete: async () => {},
          completeExceptionally: async () => {},
        },
      },
      workflow: workflow(id),
      liveObservations,
      finalizerStatus: null,
    },
  });
}

describe('TimelineTab pagination', () => {
  test('supports Previous, Next, and jump-to-step beyond the threshold', async () => {
    const { getByText, getByRole, queryByText } = renderTimeline('wf-paginated', entries(501));

    await waitFor(() => expect(getByText('step-1')).not.toBeNull());
    expect(getByText('Page 1 of 3')).not.toBeNull();
    expect(getByRole('button', { name: 'Previous' }).hasAttribute('disabled')).toBe(true);

    await fireEvent.click(getByRole('button', { name: 'Next' }));
    await waitFor(() => {
      expect(getByText('Page 2 of 3')).not.toBeNull();
      expect(queryByText('step-1')).toBeNull();
      expect(getByText('step-201')).not.toBeNull();
    });

    await fireEvent.click(getByRole('button', { name: 'Previous' }));
    await waitFor(() => expect(getByText('step-1')).not.toBeNull());

    const jumpInput = getByRole('textbox', { name: 'Jump to step' });
    await fireEvent.input(jumpInput, { target: { value: '450' } });
    await fireEvent.keyDown(jumpInput, { key: 'Enter' });

    await waitFor(() => {
      expect(getByText('Page 3 of 3')).not.toBeNull();
      expect(getByText('step-450')).not.toBeNull();
    });
  });

  test('a narrowing quick filter resets an out-of-range page', async () => {
    const { getByText, getByRole } = renderTimeline('wf-filtered-pagination', entries(601, 501));

    await waitFor(() => expect(getByText('Page 1 of 4')).not.toBeNull());
    await fireEvent.click(getByRole('button', { name: 'Next' }));
    await fireEvent.click(getByRole('button', { name: 'Next' }));
    await fireEvent.click(getByRole('button', { name: 'Next' }));
    await waitFor(() => expect(getByText('Page 4 of 4')).not.toBeNull());

    await fireEvent.click(getByRole('radio', { name: 'Failed' }));

    await waitFor(() => {
      expect(getByText('Page 1 of 3')).not.toBeNull();
      expect(getByText('step-1')).not.toBeNull();
    });
  });

  test('an invalid jump-to-step value is a no-op', async () => {
    const { getByText, getByRole } = renderTimeline('wf-paginated-invalid', entries(501));

    await waitFor(() => expect(getByText('step-1')).not.toBeNull());
    const jumpInput = getByRole('textbox', { name: 'Jump to step' });
    await fireEvent.input(jumpInput, { target: { value: 'not-a-number' } });
    await fireEvent.keyDown(jumpInput, { key: 'Enter' });

    expect(getByText('Page 1 of 3')).not.toBeNull();
  });
});
