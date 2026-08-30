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
 */
import { fireEvent, render, waitFor } from '@testing-library/svelte';
import { describe, expect, test } from 'bun:test';

import { HttpClient } from '@lostgradient/weft/client';

import { startLiveSourceTestServer } from '../../lib/live-source/live-source-test-server.test-support.ts';
import ScheduleFormDrawerHarness from './schedule-form-drawer-test-harness.test-harness.svelte';

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
