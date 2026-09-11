/**
 * Component tests for `<ScheduleFormDrawer>` against a REAL in-process weft
 * server.
 *
 * The registry-driven workflow-type picker still exercises its free-text
 * fallback here, not the Select: `client.operations[name]` (the registry
 * query) always goes through `HttpClient`'s JSON-RPC catalog transport
 * (`${baseUrl}/jsonrpc`, verified in `weft/src/client/http-operations.ts`).
 * `live-source-test-server.test-support.ts`'s harness is a real `serve()` as
 * of `@lostgradient/weft@0.12.0` and does route `/jsonrpc` now (the
 * `handleRequest()`-only limitation this comment used to describe, tracked
 * as weft#710, is fixed) — this file simply hasn't been extended to also
 * cover the populated-Select path against the real server; that path is
 * covered against a fake `RegistryProbeClient` in
 * `schedule-form-fields.test.ts` instead. These tests still confirm the
 * free-text fallback works end-to-end, which is real coverage on its own.
 *
 * The free-text fallback here is deterministic regardless of when the real
 * registry HTTP round-trip settles relative to a test's assertions: this
 * harness's `Engine` registers no workflows, so `fetchRegisteredWorkflowTypes`
 * always resolves to `[]`, and `schedule-form-fields.svelte` treats a
 * resolved-but-empty array the same as still-loading/errored (WFT-6) — the
 * workflow-type field never switches to a zero-option `Select` no matter how
 * slow or fast the round-trip is on a given test run.
 */
import { fireEvent, render, waitFor } from '@testing-library/svelte';
import { describe, expect, test } from 'bun:test';

import { HttpClient } from '@lostgradient/weft/client';
import type { QueryClient } from '@tanstack/svelte-query';

import { startLiveSourceTestServer } from '../../lib/live-source/live-source-test-server.test-support.ts';
import ScheduleFormDrawerHarness from './schedule-form-drawer-test-harness.test-harness.svelte';
import { scheduleDetailQueryKey } from './schedule-queries.ts';

describe('ScheduleFormDrawer — create', () => {
  test('creates a schedule with the selected workflow type and default cadence', async () => {
    const server = await startLiveSourceTestServer();
    const client = new HttpClient({ baseUrl: server.baseUrl, token: server.token });

    let closed = false;
    try {
      const { getByRole } = render(ScheduleFormDrawerHarness, {
        props: { client, mode: 'create', onClose: () => (closed = true) },
      });

      const workflowTypeInput = await waitFor(() =>
        getByRole('textbox', { name: 'Workflow type' }),
      );
      await fireEvent.input(workflowTypeInput, { target: { value: 'inventory-sync-sweep' } });

      const idInput = getByRole('textbox', { name: 'Schedule ID' });
      await fireEvent.input(idInput, { target: { value: 'test-created-schedule' } });

      await fireEvent.click(getByRole('button', { name: 'Create schedule' }));

      await waitFor(() => expect(closed).toBe(true));
      const created = await server.engine.getSchedule('test-created-schedule');
      expect(created?.workflowType).toBe('inventory-sync-sweep');
    } finally {
      await server.stop();
    }
  });

  test('creating with "Start paused" checked leaves the schedule paused', async () => {
    const server = await startLiveSourceTestServer();
    const client = new HttpClient({ baseUrl: server.baseUrl, token: server.token });

    let closed = false;
    try {
      const { getByRole } = render(ScheduleFormDrawerHarness, {
        props: { client, mode: 'create', onClose: () => (closed = true) },
      });

      const workflowTypeInput = await waitFor(() =>
        getByRole('textbox', { name: 'Workflow type' }),
      );
      await fireEvent.input(workflowTypeInput, { target: { value: 'inventory-sync-sweep' } });

      const idInput = getByRole('textbox', { name: 'Schedule ID' });
      await fireEvent.input(idInput, { target: { value: 'test-paused-schedule' } });

      await fireEvent.click(getByRole('switch', { name: 'Start paused' }));
      await fireEvent.click(getByRole('button', { name: 'Create schedule' }));

      await waitFor(() => expect(closed).toBe(true));
      const created = await server.engine.getSchedule('test-paused-schedule');
      expect(created?.status).toBe('paused');
    } finally {
      await server.stop();
    }
  });

  test('the submit button is disabled with a reason pill when schedules:write is missing', async () => {
    const server = await startLiveSourceTestServer();
    const client = new HttpClient({ baseUrl: server.baseUrl, token: server.token });

    try {
      const { getByRole, getByText } = render(ScheduleFormDrawerHarness, {
        props: {
          client,
          mode: 'create',
          onClose: () => {},
          scopes: ['schedules:read'],
        },
      });

      await waitFor(() => {
        expect(
          (getByRole('button', { name: 'Create schedule' }) as HTMLButtonElement).disabled,
        ).toBe(true);
      });
      expect(getByText('Requires schedules:write')).not.toBeNull();
    } finally {
      await server.stop();
    }
  });

  test('the submit button stays disabled until the form is valid', async () => {
    const server = await startLiveSourceTestServer();
    const client = new HttpClient({ baseUrl: server.baseUrl, token: server.token });

    try {
      const { getByRole } = render(ScheduleFormDrawerHarness, {
        props: { client, mode: 'create', onClose: () => {} },
      });

      // No workflow type chosen yet — invalid.
      await waitFor(() => {
        expect(
          (getByRole('button', { name: 'Create schedule' }) as HTMLButtonElement).disabled,
        ).toBe(true);
      });
    } finally {
      await server.stop();
    }
  });
});

describe('ScheduleFormDrawer — edit', () => {
  test('prefills the cadence from the existing schedule and updates it on save', async () => {
    const server = await startLiveSourceTestServer();
    await server.engine.schedule({
      workflow: 'inventory-sync-sweep',
      id: 'nightly-rollup',
      cron: '0 2 * * *',
      input: { warehouseId: 'wh-main' },
    });
    const client = new HttpClient({ baseUrl: server.baseUrl, token: server.token });

    let closed = false;
    try {
      const { getByRole } = render(ScheduleFormDrawerHarness, {
        props: {
          client,
          mode: 'edit',
          scheduleId: 'nightly-rollup',
          onClose: () => (closed = true),
        },
      });

      const workflowTypeField = await waitFor(() =>
        getByRole('textbox', { name: 'Workflow type' }),
      );
      expect((workflowTypeField as HTMLInputElement).value).toBe('inventory-sync-sweep');
      expect((workflowTypeField as HTMLInputElement).disabled).toBe(true);

      await fireEvent.click(getByRole('button', { name: 'Save changes' }));

      await waitFor(() => expect(closed).toBe(true));
      const updated = await server.engine.getSchedule('nightly-rollup');
      // Cadence unchanged (no edit made) but the round trip through
      // updateSchedule() must succeed against the real server.
      expect(updated?.cronExpression).toBe('0 2 * * *');
    } finally {
      await server.stop();
    }
  });

  test('prefills revisionPolicy from the fetched ScheduleSummary and leaves it unchanged on an unrelated save (WFT-117)', async () => {
    const server = await startLiveSourceTestServer();
    await server.engine.schedule({
      workflow: 'inventory-sync-sweep',
      id: 'pinned-rollup',
      cron: '0 2 * * *',
      input: { warehouseId: 'wh-main' },
      revisionPolicy: 'pinned',
    });
    const client = new HttpClient({ baseUrl: server.baseUrl, token: server.token });

    let closed = false;
    try {
      const { getByRole } = render(ScheduleFormDrawerHarness, {
        props: {
          client,
          mode: 'edit',
          scheduleId: 'pinned-rollup',
          onClose: () => (closed = true),
        },
      });

      const pinnedRadio = await waitFor(() => getByRole('radio', { name: 'Pinned' }));
      expect((pinnedRadio as HTMLInputElement).checked).toBe(true);

      const before = await server.engine.getSchedule('pinned-rollup');
      const pinnedRevisionBefore = before?.pinnedRevision;

      await fireEvent.click(getByRole('button', { name: 'Save changes' }));
      await waitFor(() => expect(closed).toBe(true));

      // Unchanged revisionPolicy must not resend it — the pin is never
      // silently re-captured by an unrelated cadence-only save.
      const after = await server.engine.getSchedule('pinned-rollup');
      expect(after?.revisionPolicy).toBe('pinned');
      expect(after?.pinnedRevision).toBe(pinnedRevisionBefore);
    } finally {
      await server.stop();
    }
  });

  test('changing revisionPolicy from active-at-fire to pinned and saving sends the new value (WFT-117)', async () => {
    const server = await startLiveSourceTestServer();
    await server.engine.schedule({
      workflow: 'inventory-sync-sweep',
      id: 'to-be-pinned',
      cron: '0 2 * * *',
      input: { warehouseId: 'wh-main' },
    });
    const client = new HttpClient({ baseUrl: server.baseUrl, token: server.token });

    let closed = false;
    try {
      const { getByRole } = render(ScheduleFormDrawerHarness, {
        props: {
          client,
          mode: 'edit',
          scheduleId: 'to-be-pinned',
          onClose: () => (closed = true),
        },
      });

      await waitFor(() => getByRole('radio', { name: 'Active at fire' }));
      await fireEvent.click(getByRole('radio', { name: 'Pinned' }));
      await fireEvent.click(getByRole('button', { name: 'Save changes' }));
      await waitFor(() => expect(closed).toBe(true));

      const after = await server.engine.getSchedule('to-be-pinned');
      expect(after?.revisionPolicy).toBe('pinned');
    } finally {
      await server.stop();
    }
  });

  test('a background refetch that swaps `form` mid-edit does not leak the stale revisionPolicy draft onto the new form (Codex review, PR #978, round 2)', async () => {
    // Reproduces the exact race the finding described: an external actor
    // (e.g. the System route's Activate flow) changes the schedule's
    // `revisionPolicy` on the server WHILE this drawer is open; a refetch
    // of `editDetailQuery` then reconstructs `form` as a brand-new
    // `ScheduleFormState` carrying the externally-updated value. Before the
    // `{#key form}` fix, `schedule-form-fields.svelte`'s one-shot draft
    // would have kept the OLD 'active-at-fire' value and silently written
    // it back into the new form, so a subsequent unrelated save would have
    // reverted the external pin. This proves it doesn't.
    const server = await startLiveSourceTestServer();
    await server.engine.schedule({
      workflow: 'inventory-sync-sweep',
      id: 'externally-pinned',
      cron: '0 2 * * *',
      input: { warehouseId: 'wh-main' },
    });
    const client = new HttpClient({ baseUrl: server.baseUrl, token: server.token });

    let closed = false;
    let queryClient: QueryClient | undefined;
    try {
      const { getByRole } = render(ScheduleFormDrawerHarness, {
        props: {
          client,
          mode: 'edit',
          scheduleId: 'externally-pinned',
          onClose: () => (closed = true),
          onQueryClient: (qc) => (queryClient = qc),
        },
      });

      await waitFor(() => {
        const radio = getByRole('radio', { name: 'Active at fire' }) as HTMLInputElement;
        expect(radio.checked).toBe(true);
      });

      // Out-of-band change: NOT through this drawer's own form submission.
      await server.engine.updateSchedule('externally-pinned', '0 2 * * *', {
        revisionPolicy: 'pinned',
      });
      if (queryClient === undefined) throw new Error('queryClient was never captured');
      await queryClient.invalidateQueries({
        queryKey: scheduleDetailQueryKey('externally-pinned'),
      });

      await waitFor(() => {
        const radio = getByRole('radio', { name: 'Pinned' }) as HTMLInputElement;
        expect(radio.checked).toBe(true);
      });

      // An unrelated save after the refetch — must not resend the OLD draft.
      await fireEvent.click(getByRole('button', { name: 'Save changes' }));
      await waitFor(() => expect(closed).toBe(true));

      const after = await server.engine.getSchedule('externally-pinned');
      expect(after?.revisionPolicy).toBe('pinned');
    } finally {
      await server.stop();
    }
  });

  test('renders the not-found fault when the schedule no longer exists', async () => {
    const server = await startLiveSourceTestServer();
    const client = new HttpClient({ baseUrl: server.baseUrl, token: server.token });

    try {
      const { getByText } = render(ScheduleFormDrawerHarness, {
        props: { client, mode: 'edit', scheduleId: 'missing', onClose: () => {} },
      });

      await waitFor(() => expect(getByText('Not found')).not.toBeNull());
    } finally {
      await server.stop();
    }
  });
});
