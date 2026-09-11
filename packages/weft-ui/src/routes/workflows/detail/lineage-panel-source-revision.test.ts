/**
 * `LineagePanel`'s "Forked from" source-revision attribution — split out of
 * `lineage-panel.test.ts` (WFT-117, Codex review round 2) purely to stay
 * under the 500-line implementation-file cap; same harness, same fixture
 * helpers, no behavioral difference from being colocated in one file. See
 * `lineage-panel.svelte`'s module doc, "Revision display" section, for the
 * `sourceRevisionAttributable` invariant these tests prove.
 */
import { render, waitFor } from '@testing-library/svelte';
import { describe, expect, test } from 'bun:test';

import type {
  PaginatedResult,
  WorkflowScheduleProvenance,
  WorkflowState,
  WorkflowSummary,
} from '@lostgradient/weft';

import LineagePanelHarness from './lineage-panel.test-harness.svelte';

function workflow(overrides: Partial<WorkflowState> = {}): WorkflowState {
  return {
    id: 'wf_current',
    type: 'order-fulfillment',
    status: 'running',
    input: {},
    versionTuple: { workflowVersion: '1' },
    createdAt: 1_000,
    updatedAt: 1_000,
    ...overrides,
  };
}

function emptyChildren(): PaginatedResult<WorkflowSummary> {
  return { items: [], total: 0, offset: 0, limit: 5 };
}

function noProvenance(): Promise<WorkflowScheduleProvenance | null> {
  return Promise.resolve(null);
}

function baseClient(
  overrides: {
    get?: (id: string) => Promise<WorkflowState | null>;
    list?: () => Promise<PaginatedResult<WorkflowSummary>>;
    scheduleProvenance?: () => Promise<WorkflowScheduleProvenance | null>;
  } = {},
) {
  return {
    get: overrides.get ?? (async () => null),
    list: overrides.list ?? (async () => emptyChildren()),
    operations: {
      'weft.workflows.scheduleprovenance.get': overrides.scheduleProvenance ?? noProvenance,
    },
  };
}

describe('LineagePanel — forked-from source revision attribution', () => {
  test('shows the forked-from source run’s own revision once forkSourceQuery resolves', async () => {
    const client = baseClient({
      get: async (id) =>
        id === 'wf_source'
          ? workflow({
              id: 'wf_source',
              type: 'reconcile-ledger',
              revision: 'reconcile-rev-abc',
              // Must originate strictly before the forking run's own
              // `createdAt` (1_000, the `workflow()` default below) for
              // `sourceRevisionAttributable` to treat it as the real source.
              createdAt: 500,
            })
          : null,
    });

    const { getByText } = render(LineagePanelHarness, {
      props: {
        client,
        workflow: workflow({ forkedFrom: { workflowId: 'wf_source', step: 12 } }),
      },
    });

    await waitFor(() => {
      expect(getByText('reconcile-ledger')).not.toBeNull();
    });
    expect(getByText(/^rev reconcil/)).not.toBeNull();
  });

  test('shows an explicit "Unpinned" badge — not a silent blank — when the forked-from source is attributable but has no persisted revision (Codex review, PR #978)', async () => {
    // `sourceRevisionAttributable` is true (the fetched generation
    // predates this fork), but `data.revision` is `undefined` — a legacy
    // source that predates revision pinning entirely. Before this fix,
    // neither the attributable-with-revision branch nor the
    // not-attributable branch matched this combination, so the row
    // rendered nothing at all.
    const client = baseClient({
      get: async (id) =>
        id === 'wf_source'
          ? workflow({ id: 'wf_source', type: 'reconcile-ledger', createdAt: 500 })
          : null,
    });

    const { getByText, queryByText } = render(LineagePanelHarness, {
      props: {
        client,
        workflow: workflow({ forkedFrom: { workflowId: 'wf_source', step: 12 } }),
      },
    });

    await waitFor(() => {
      expect(getByText('reconcile-ledger')).not.toBeNull();
    });
    expect(getByText('Unpinned')).not.toBeNull();
    expect(queryByText(/^rev /)).toBeNull();
    expect(queryByText('Revision not attributable')).toBeNull();
  });

  test('omits the source-revision chip and shows "Revision not attributable" when the source id was reused by a TRACKED start-new restart AFTER this fork was created (Codex review, PR #978, round 1)', async () => {
    // `client.get` always returns the source id's LATEST generation. Here
    // that generation's own `createdAt` (2_000) is AFTER the forking run's
    // own `createdAt` (1_000, the `workflow()` default) — this fetched
    // record post-dates the fork, so its `revision` cannot honestly be
    // attributed to the run that was actually forked from. `restartedFrom`
    // is present here (the realistic shape a tracked restart produces) but
    // is not what the guard actually checks — see the next test.
    const client = baseClient({
      get: async (id) =>
        id === 'wf_source'
          ? workflow({
              id: 'wf_source',
              type: 'reconcile-ledger',
              revision: 'reconcile-rev-replacement',
              createdAt: 2_000,
              restartedFrom: { workflowId: 'wf_source', replacedAt: 2_000 },
            })
          : null,
    });

    const { getByText, queryByText } = render(LineagePanelHarness, {
      props: {
        client,
        workflow: workflow({ forkedFrom: { workflowId: 'wf_source', step: 12 } }),
      },
    });

    await waitFor(() => {
      expect(getByText('reconcile-ledger')).not.toBeNull();
    });
    expect(getByText('Revision not attributable')).not.toBeNull();
    expect(queryByText(/^rev reconcil/)).toBeNull();
  });

  test('omits the source-revision chip for an UNTRACKED id reuse — a purged source id fresh-started again with no restartedFrom at all (Codex review, PR #978, round 2)', async () => {
    // The gap the first round's `restartedFrom`-only guard missed: the
    // original fork source can be purged, then a plain `engine.start()`
    // (not `onTerminalConflict: 'start-new'`) can reuse the SAME explicit
    // id for an entirely unrelated run. That fresh generation carries no
    // `restartedFrom` at all — a naive "no restartedFrom means safe" check
    // would wrongly attribute it. The `createdAt`-only comparison used here
    // catches this because it needs no restart-lineage signal at all: this
    // generation's `createdAt` (5_000) is still after the fork's own
    // `createdAt` (1_000), so it's withheld regardless of `restartedFrom`.
    const client = baseClient({
      get: async (id) =>
        id === 'wf_source'
          ? workflow({
              id: 'wf_source',
              type: 'reconcile-ledger',
              revision: 'reconcile-rev-unrelated',
              createdAt: 5_000,
              // Deliberately no `restartedFrom` — this is the untracked case.
            })
          : null,
    });

    const { getByText, queryByText } = render(LineagePanelHarness, {
      props: {
        client,
        workflow: workflow({ forkedFrom: { workflowId: 'wf_source', step: 12 } }),
      },
    });

    await waitFor(() => {
      expect(getByText('reconcile-ledger')).not.toBeNull();
    });
    expect(getByText('Revision not attributable')).not.toBeNull();
    expect(queryByText(/^rev reconcil/)).toBeNull();
  });

  test('still shows the source-revision chip when the fetched generation originated BEFORE this fork was created', async () => {
    // The source's own `createdAt` (1_000) is BEFORE this fork's own
    // `createdAt` (5_000) — since `client.get` always returns the current,
    // unreplaced generation, this generation has existed continuously since
    // 1_000 through now, so it was necessarily current at fork time (5_000)
    // too. Its revision is the real source, regardless of `restartedFrom`.
    const client = baseClient({
      get: async (id) =>
        id === 'wf_source'
          ? workflow({
              id: 'wf_source',
              type: 'reconcile-ledger',
              revision: 'reconcile-rev-abc',
              createdAt: 1_000,
              restartedFrom: { workflowId: 'wf_source', replacedAt: 1_000 },
            })
          : null,
    });

    const { getByText, queryByText } = render(LineagePanelHarness, {
      props: {
        client,
        workflow: workflow({
          createdAt: 5_000,
          forkedFrom: { workflowId: 'wf_source', step: 12 },
        }),
      },
    });

    await waitFor(() => {
      expect(getByText('reconcile-ledger')).not.toBeNull();
    });
    expect(getByText(/^rev reconcil/)).not.toBeNull();
    expect(queryByText('Revision not attributable')).toBeNull();
  });
});
