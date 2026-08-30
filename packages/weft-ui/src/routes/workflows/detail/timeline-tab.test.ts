import { fireEvent, render, waitFor } from '@testing-library/svelte';
import { describe, expect, test } from 'bun:test';

import type { WorkflowState, WorkflowTimelineEntry } from '@lostgradient/weft';
import { QueryClient } from '@tanstack/svelte-query';

import type { FleetEventFrame } from '../../../lib/live-source/fleet-event-source.svelte.ts';
import TimelineTabHarness from './timeline-tab.test-harness.svelte';
import { WorkflowLiveObservations } from './timeline/workflow-live-observations.svelte.ts';

function workflow(overrides: Partial<WorkflowState> = {}): WorkflowState {
  return {
    id: 'wf-1',
    type: 'trip-booking-saga',
    status: 'running',
    input: {},
    versionTuple: { workflowVersion: '1' },
    createdAt: 1_000,
    updatedAt: 1_000,
    ...overrides,
  };
}

function entry(overrides: Partial<WorkflowTimelineEntry>): WorkflowTimelineEntry {
  return {
    step: 1,
    operationType: 'activity',
    operationLabel: 'doThing',
    inputSummary: '{}',
    timestamp: 1_000,
    status: 'completed',
    ...overrides,
  };
}

class InertFleet {
  caughtUp = false;
  #handler: ((frame: FleetEventFrame) => void) | null = null;

  subscribe(onFrame: (frame: FleetEventFrame) => void): () => void {
    this.#handler = onFrame;
    return () => {
      this.#handler = null;
    };
  }

  emit(frame: FleetEventFrame): void {
    this.#handler?.(frame);
  }
}

function inertQueryClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function baseClient(
  entries: WorkflowTimelineEntry[],
  pendingItems: ReadonlyArray<{
    token: string;
    operationId: string;
    activityName: string;
    step: number;
    attempt: number;
    createdAt: number;
  }> = [],
) {
  return {
    getTimeline: async () => entries,
    operations: {
      'weft.workflows.activities.pending.list': async () => ({ items: pendingItems }),
    },
    activity: {
      complete: async () => {},
      completeExceptionally: async () => {},
    },
  };
}

describe('TimelineTab', () => {
  test('shows an empty state with no timeline entries', async () => {
    const liveObservations = new WorkflowLiveObservations(
      new InertFleet(),
      inertQueryClient(),
      'wf-1',
    );

    const { getByText } = render(TimelineTabHarness, {
      props: {
        client: baseClient([]),
        workflow: workflow(),
        liveObservations,
        finalizerStatus: null,
      },
    });

    await waitFor(() => expect(getByText('No timeline entries yet')).not.toBeNull());
  });

  test('renders steps in order with their labels', async () => {
    const liveObservations = new WorkflowLiveObservations(
      new InertFleet(),
      inertQueryClient(),
      'wf-1',
    );
    const entries = [
      entry({ step: 1, operationLabel: 'reserveFlight' }),
      entry({ step: 2, operationLabel: 'reserveHotel', status: 'running' }),
    ];

    const { getByText } = render(TimelineTabHarness, {
      props: {
        client: baseClient(entries),
        workflow: workflow(),
        liveObservations,
        finalizerStatus: null,
      },
    });

    await waitFor(() => {
      expect(getByText('reserveFlight')).not.toBeNull();
      expect(getByText('reserveHotel')).not.toBeNull();
    });
  });

  test('clicking a step selects it and shows the linked-selection chip, Clear removes it', async () => {
    const liveObservations = new WorkflowLiveObservations(
      new InertFleet(),
      inertQueryClient(),
      'wf-1',
    );
    const entries = [entry({ step: 1, operationLabel: 'reserveFlight' })];

    const { getByText, queryByText } = render(TimelineTabHarness, {
      props: {
        client: baseClient(entries),
        workflow: workflow({ id: 'wf-select-1' }),
        liveObservations,
        finalizerStatus: null,
      },
    });

    await waitFor(() => expect(getByText('reserveFlight')).not.toBeNull());
    await fireEvent.click(getByText('reserveFlight'));

    await waitFor(() => {
      expect(getByText('Selected — Events filtered to this step')).not.toBeNull();
    });

    await fireEvent.click(getByText('Clear'));

    await waitFor(() => {
      expect(queryByText('Selected — Events filtered to this step')).toBeNull();
    });
  });

  /**
   * WFC-7: selection's keyboard/ARIA control is Cinder's own now —
   * `RunStepTimeline`'s `selection-control` button, rendered because
   * `timeline-tab.svelte` passes `onStepSelect`. It's a native `<button>`
   * (reachable by Tab, activated by Enter/Space via the platform — no manual
   * keydown wiring needed), labeled `Select <step label>` and exposing
   * `aria-pressed`. This also guards against double-handling: Cinder's row
   * click and its selection-control button share one delegated handler
   * (verified against `run-step-timeline`'s source), so a single click
   * toggles exactly once — there is no app-owned row delegate left to fire
   * a second time.
   */
  test('the Cinder selection-control button toggles aria-pressed and the linked-selection chip on a single click', async () => {
    const liveObservations = new WorkflowLiveObservations(
      new InertFleet(),
      inertQueryClient(),
      'wf-1',
    );
    const entries = [entry({ step: 1, operationLabel: 'reserveFlight' })];

    const { getByRole, getByText, queryByText } = render(TimelineTabHarness, {
      props: {
        client: baseClient(entries),
        workflow: workflow({ id: 'wf-select-2' }),
        liveObservations,
        finalizerStatus: null,
      },
    });

    await waitFor(() => expect(getByText('reserveFlight')).not.toBeNull());
    const selectButton = getByRole('button', { name: 'Select reserveFlight' });
    expect(selectButton.getAttribute('aria-pressed')).toBe('false');

    await fireEvent.click(selectButton);

    await waitFor(() => {
      expect(getByText('Selected — Events filtered to this step')).not.toBeNull();
    });
    expect(getByRole('button', { name: 'Select reserveFlight' }).getAttribute('aria-pressed')).toBe(
      'true',
    );

    await fireEvent.click(getByRole('button', { name: 'Select reserveFlight' }));

    await waitFor(() => {
      expect(queryByText('Selected — Events filtered to this step')).toBeNull();
    });
    expect(getByRole('button', { name: 'Select reserveFlight' }).getAttribute('aria-pressed')).toBe(
      'false',
    );
  });

  test('the Failed quick filter narrows the rendered steps', async () => {
    const liveObservations = new WorkflowLiveObservations(
      new InertFleet(),
      inertQueryClient(),
      'wf-1',
    );
    const entries = [
      entry({ step: 1, operationLabel: 'reserveFlight', status: 'completed' }),
      entry({ step: 2, operationLabel: 'chargeTripCard', status: 'failed' }),
    ];

    const { getByText, getByRole, queryByText } = render(TimelineTabHarness, {
      props: {
        client: baseClient(entries),
        workflow: workflow({ id: 'wf-filter-1' }),
        liveObservations,
        finalizerStatus: null,
      },
    });

    await waitFor(() => expect(getByText('reserveFlight')).not.toBeNull());
    await fireEvent.click(getByRole('radio', { name: 'Failed' }));

    await waitFor(() => {
      expect(queryByText('reserveFlight')).toBeNull();
      expect(getByText('chargeTripCard')).not.toBeNull();
    });
  });

  test('shows the Finalizing badge when the durable finalizer field reports still-in-flight (weft#732 item 4)', async () => {
    const fleet = new InertFleet();
    const liveObservations = new WorkflowLiveObservations(fleet, inertQueryClient(), 'wf-1');

    const { getByText } = render(TimelineTabHarness, {
      props: {
        client: baseClient([]),
        workflow: workflow({ status: 'cancelled' }),
        liveObservations,
        finalizerStatus: { status: 'running', attempts: 1, startedAt: 1 },
      },
    });

    await waitFor(() => expect(getByText('Finalizing')).not.toBeNull());
  });

  test('an unambiguous pending async activity badges the matching step', async () => {
    const fleet = new InertFleet();
    const liveObservations = new WorkflowLiveObservations(fleet, inertQueryClient(), 'wf-1');
    const entries = [
      entry({
        step: 1,
        operationType: 'activity',
        operationLabel: 'printShippingLabel',
        status: 'running',
      }),
    ];

    const { getByText } = render(TimelineTabHarness, {
      props: {
        client: baseClient(entries, [
          {
            token: 'tok-1',
            operationId: 'op-1',
            activityName: 'printShippingLabel',
            step: 1,
            attempt: 1,
            createdAt: 1,
          },
        ]),
        workflow: workflow({ id: 'wf-1', status: 'running' }),
        liveObservations,
        finalizerStatus: null,
      },
    });

    await waitFor(() => {
      expect(getByText('printShippingLabel')).not.toBeNull();
      expect(getByText('Awaiting external completion')).not.toBeNull();
    });
  });

  test('an ambiguous (unattached) pending async activity shows in the standalone list instead of on a step', async () => {
    const fleet = new InertFleet();
    const liveObservations = new WorkflowLiveObservations(fleet, inertQueryClient(), 'wf-1');
    // No matching timeline entry at all — the observation stays unattached.
    const entries = [entry({ step: 1, operationLabel: 'unrelatedStep', status: 'completed' })];

    const { getByText } = render(TimelineTabHarness, {
      props: {
        client: baseClient(entries, [
          {
            token: 'tok-1',
            operationId: 'op-1',
            activityName: 'printShippingLabel',
            step: 1,
            attempt: 1,
            createdAt: 1,
          },
        ]),
        workflow: workflow({ id: 'wf-1' }),
        liveObservations,
        finalizerStatus: null,
      },
    });

    await waitFor(() => {
      expect(getByText(/Couldn't link this to a single timeline step/)).not.toBeNull();
    });
  });

  test('the Coordination and Saga quick filters narrow the rendered steps', async () => {
    const liveObservations = new WorkflowLiveObservations(
      new InertFleet(),
      inertQueryClient(),
      'wf-1',
    );
    // `race` and `parallel` entries render their STRUCTURAL label ("Race" /
    // "All (parallel)"), not their raw `operationLabel` — see
    // `timeline-mapping.ts`'s `STRUCTURAL_OPERATION_LABEL`.
    const entries = [
      entry({ step: 1, operationType: 'race', operationLabel: 'raceProviders' }),
      entry({ step: 2, operationType: 'activity', operationLabel: 'compensate:refund' }),
      entry({ step: 3, operationType: 'activity', operationLabel: 'chargeCard' }),
    ];

    const { getByText, getByRole, queryByText } = render(TimelineTabHarness, {
      props: {
        client: baseClient(entries),
        workflow: workflow({ id: 'wf-filter-coord' }),
        liveObservations,
        finalizerStatus: null,
      },
    });

    await waitFor(() => expect(getByText('Race')).not.toBeNull());
    await fireEvent.click(getByRole('radio', { name: 'Coordination' }));
    await waitFor(() => {
      expect(getByText('Race')).not.toBeNull();
      expect(queryByText('chargeCard')).toBeNull();
    });

    await fireEvent.click(getByRole('radio', { name: 'Saga' }));
    await waitFor(() => {
      expect(getByText('compensate:refund')).not.toBeNull();
      expect(queryByText('Race')).toBeNull();
    });
  });

  test('a cancelled workflow with a failed finalizer shows the cleanup-failed strip', async () => {
    const liveObservations = new WorkflowLiveObservations(
      new InertFleet(),
      inertQueryClient(),
      'wf-1',
    );

    const { getByText } = render(TimelineTabHarness, {
      props: {
        client: baseClient([]),
        workflow: workflow({ status: 'cancelled' }),
        liveObservations,
        finalizerStatus: { status: 'failed', attempts: 2, failedAt: 1, error: 'boom' },
      },
    });

    await waitFor(() => expect(getByText(/cleanup failed/i)).not.toBeNull());
  });

  test('clicking Complete… on a step with an attached pending activity opens the async-activity drawer, and closing it clears the selection', async () => {
    const fleet = new InertFleet();
    const liveObservations = new WorkflowLiveObservations(fleet, inertQueryClient(), 'wf-1');
    const entries = [
      entry({
        step: 1,
        operationType: 'activity',
        operationLabel: 'printShippingLabel',
        status: 'running',
      }),
    ];

    const { getByText, getAllByRole, getByRole, queryByText } = render(TimelineTabHarness, {
      props: {
        client: baseClient(entries, [
          {
            token: 'tok-drawer-1',
            operationId: 'op-1',
            activityName: 'printShippingLabel',
            step: 1,
            attempt: 1,
            createdAt: 1,
          },
        ]),
        workflow: workflow({ id: 'wf-drawer-1', status: 'running' }),
        liveObservations,
        finalizerStatus: null,
      },
    });

    await waitFor(() => expect(getByText('printShippingLabel')).not.toBeNull());
    const [completeButton] = getAllByRole('button', { name: 'Complete…' });
    if (!completeButton) throw new Error('expected a Complete… button');
    await fireEvent.click(completeButton);

    await waitFor(() => {
      expect(getByText('tok-drawer-1')).not.toBeNull();
    });

    await fireEvent.click(getByRole('button', { name: 'Close drawer' }));

    await waitFor(() => {
      expect(queryByText('tok-drawer-1')).toBeNull();
    });
  });

  test('paginates the timeline past the step-range threshold, with working Previous/Next and jump-to-step', async () => {
    const liveObservations = new WorkflowLiveObservations(
      new InertFleet(),
      inertQueryClient(),
      'wf-1',
    );
    const entries = Array.from({ length: 501 }, (_, index) =>
      entry({ step: index + 1, operationLabel: `step-${index + 1}` }),
    );

    const { getByText, getByRole, queryByText } = render(TimelineTabHarness, {
      props: {
        client: baseClient(entries),
        workflow: workflow({ id: 'wf-paginated' }),
        liveObservations,
        finalizerStatus: null,
      },
    });

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

  test('an invalid jump-to-step value is a no-op', async () => {
    const liveObservations = new WorkflowLiveObservations(
      new InertFleet(),
      inertQueryClient(),
      'wf-1',
    );
    const entries = Array.from({ length: 501 }, (_, index) =>
      entry({ step: index + 1, operationLabel: `step-${index + 1}` }),
    );

    const { getByText, getByRole } = render(TimelineTabHarness, {
      props: {
        client: baseClient(entries),
        workflow: workflow({ id: 'wf-paginated-invalid' }),
        liveObservations,
        finalizerStatus: null,
      },
    });

    await waitFor(() => expect(getByText('step-1')).not.toBeNull());
    const jumpInput = getByRole('textbox', { name: 'Jump to step' });
    await fireEvent.input(jumpInput, { target: { value: 'not-a-number' } });
    await fireEvent.keyDown(jumpInput, { key: 'Enter' });

    expect(getByText('Page 1 of 3')).not.toBeNull();
  });
});
