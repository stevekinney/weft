import { fireEvent, render, waitFor } from '@testing-library/svelte';
import { describe, expect, test } from 'bun:test';

import type { WorkflowListQuery } from '../../../lib/filters.ts';
import type { ScopeGate } from '../../../lib/scopes.svelte.ts';
import BulkSelectionBar from './bulk-selection-bar.svelte';
import { realClient, ScriptedFetch } from './workflow-test-support.test-support.ts';

const GRANTED: ScopeGate = { disabled: false, title: undefined };
const DENIED: ScopeGate = { disabled: true, title: 'Requires workflows:admin' };

function baseProps(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    client: realClient(),
    filter: { status: 'failed' } as WorkflowListQuery,
    selectedCount: 3,
    totalMatchingFilter: 47,
    onDeselect: () => {},
    adminGate: GRANTED,
    onActionComplete: () => {},
    ...overrides,
  };
}

describe('BulkSelectionBar', () => {
  test('renders nothing when nothing is selected', async () => {
    const { container } = render(BulkSelectionBar, {
      props: baseProps({ selectedCount: 0 }),
    });

    expect(container.querySelector('.weft-bulk-bar')).toBeNull();
  });

  test('shows the selection count and the select-all-matching banner', async () => {
    const { getByText, getByRole } = render(BulkSelectionBar, { props: baseProps() });

    expect(getByText('3 selected')).not.toBeNull();
    expect(getByRole('checkbox', { name: /Select all 47 matching the filter/ })).not.toBeNull();
  });

  test('Deselect calls onDeselect', async () => {
    let deselected = false;
    const { getByRole } = render(BulkSelectionBar, {
      props: baseProps({
        onDeselect: () => {
          deselected = true;
        },
      }),
    });

    await fireEvent.click(getByRole('button', { name: 'Deselect' }));
    expect(deselected).toBe(true);
  });

  test('missing workflows:admin disables every action with the scope reason', async () => {
    const { getAllByRole } = render(BulkSelectionBar, {
      props: baseProps({ adminGate: DENIED }),
    });

    const buttons = getAllByRole('button').filter((button) =>
      ['Cancel', 'Signal', 'Retry failed', 'Mutate tags', 'Delete', 'Purge'].includes(
        button.textContent?.trim() ?? '',
      ),
    ) as HTMLButtonElement[];
    expect(buttons.length).toBe(6);
    for (const button of buttons) expect(button.disabled).toBe(true);
  });

  test('scope granted but "select all matching" unchecked still disables every action', async () => {
    const { getAllByRole } = render(BulkSelectionBar, { props: baseProps() });

    const cancelButton = getAllByRole('button').find(
      (button) => button.textContent?.trim() === 'Cancel',
    ) as HTMLButtonElement;
    expect(cancelButton.disabled).toBe(true);
  });

  test('an unscoped filter disables every action even after selecting all matching', async () => {
    const { getByRole, getAllByRole } = render(BulkSelectionBar, {
      props: baseProps({ filter: {} as WorkflowListQuery }),
    });

    await fireEvent.click(getByRole('checkbox', { name: /Select all 47 matching the filter/ }));

    const cancelButton = getAllByRole('button').find(
      (button) => button.textContent?.trim() === 'Cancel',
    ) as HTMLButtonElement;
    expect(cancelButton.disabled).toBe(true);
  });

  test('granted scope + select-all-matching + a scoped filter enables the actions', async () => {
    const { getByRole, getAllByRole } = render(BulkSelectionBar, { props: baseProps() });

    await fireEvent.click(getByRole('checkbox', { name: /Select all 47 matching the filter/ }));

    const cancelButton = getAllByRole('button').find(
      (button) => button.textContent?.trim() === 'Cancel',
    ) as HTMLButtonElement;
    expect(cancelButton.disabled).toBe(false);
  });

  test('clicking Cancel (once enabled) opens the bulk cancel dialog and fires its dry run', async () => {
    const fetch = new ScriptedFetch();
    fetch.routeJsonRpcMethod('weft.workflows.bulk.cancel', {
      dryRun: true,
      action: 'cancel',
      matched: 5,
      requestId: 'bulk:req-1',
      scope: {
        matched: 5,
        filter: { status: 'failed' },
        statuses: ['failed'],
        workflowTypes: ['checkout'],
        sampleWorkflowIds: [],
        sampleLimit: 20,
      },
      sampleWorkflowIds: [],
      confirmationToken: 'bulk:token-abc',
      confirmationTokenVersion: 1,
    });

    try {
      const { getByRole, getAllByRole, getByText } = render(BulkSelectionBar, {
        props: baseProps({ client: realClient() }),
      });

      await fireEvent.click(getByRole('checkbox', { name: /Select all 47 matching the filter/ }));
      const cancelButton = getAllByRole('button').find(
        (button) => button.textContent?.trim() === 'Cancel',
      ) as HTMLButtonElement;
      await fireEvent.click(cancelButton);

      await waitFor(() => {
        expect(getByText('5 matching workflows')).not.toBeNull();
      });
    } finally {
      fetch.restore();
    }
  });

  test('clicking Purge (once enabled) opens the purge dialog using the already-known total, no dry run', async () => {
    const { getByRole, getAllByRole, getByText } = render(BulkSelectionBar, {
      props: baseProps(),
    });

    await fireEvent.click(getByRole('checkbox', { name: /Select all 47 matching the filter/ }));
    const purgeButton = getAllByRole('button').find(
      (button) => button.textContent?.trim() === 'Purge',
    ) as HTMLButtonElement;
    await fireEvent.click(purgeButton);

    await waitFor(() => {
      expect(getByText('47 terminal workflows')).not.toBeNull();
    });
  });

  test('a completed purge calls onActionComplete — the wiring behind "selection clears after a real commit"', async () => {
    // Regression coverage for the onSuccess/onClose split
    // (`bulk-action-dialog.svelte`/`bulk-purge-dialog.svelte`'s module
    // docs): caught via manual dev-harness verification that the bar's
    // "N selected" banner stayed stale after a successful purge because
    // `onActionComplete` was only wired to dialog dismissal, not to the
    // commit actually succeeding.
    const fetch = new ScriptedFetch();
    fetch.routeJsonRpcMethod('weft.workflows.purge', { deleted: 47 });

    try {
      let completed = 0;
      const { getByRole, getAllByRole, getByText, getByLabelText } = render(BulkSelectionBar, {
        props: baseProps({
          client: realClient(),
          onActionComplete: () => {
            completed += 1;
          },
        }),
      });

      await fireEvent.click(getByRole('checkbox', { name: /Select all 47 matching the filter/ }));
      const purgeButton = getAllByRole('button').find(
        (button) => button.textContent?.trim() === 'Purge',
      ) as HTMLButtonElement;
      await fireEvent.click(purgeButton);

      await waitFor(() => {
        expect(getByLabelText('Type "purge 47 workflows" to confirm')).not.toBeNull();
      });
      expect(completed).toBe(0);

      await fireEvent.input(getByLabelText('Type "purge 47 workflows" to confirm'), {
        target: { value: 'purge 47 workflows' },
      });
      await fireEvent.click(getByRole('button', { name: 'Purge 47 workflows' }));

      await waitFor(() => {
        expect(getByText('Purged 47 workflows')).not.toBeNull();
      });
      expect(completed).toBe(1);
    } finally {
      fetch.restore();
    }
  });

  test('clicking Signal opens the params form, and invalid JSON blocks continuing to the preview', async () => {
    const { getByRole, getAllByRole, getByLabelText, getByText } = render(BulkSelectionBar, {
      props: baseProps({ client: realClient() }),
    });

    await fireEvent.click(getByRole('checkbox', { name: /Select all 47 matching the filter/ }));
    const signalButton = getAllByRole('button').find(
      (button) => button.textContent?.trim() === 'Signal',
    ) as HTMLButtonElement;
    await fireEvent.click(signalButton);

    expect(getByLabelText('Signal name')).not.toBeNull();

    await fireEvent.input(getByLabelText('Signal name'), { target: { value: 'restart' } });
    await fireEvent.input(getByLabelText('Payload'), { target: { value: '{not json' } });

    expect(getByText(/Payload must be valid JSON/)).not.toBeNull();
  });

  test('a valid Signal params form runs the dry run with the signal name and parsed payload', async () => {
    const fetch = new ScriptedFetch();
    fetch.routeJsonRpcMethod('weft.workflows.bulk.signal', {
      dryRun: true,
      action: 'signal',
      matched: 2,
      requestId: 'bulk:req-signal',
      scope: {
        matched: 2,
        filter: { status: 'failed' },
        statuses: ['failed'],
        workflowTypes: [],
        sampleWorkflowIds: [],
        sampleLimit: 20,
      },
      sampleWorkflowIds: [],
      confirmationToken: 'bulk:token-signal',
      confirmationTokenVersion: 1,
    });

    try {
      const { getByRole, getAllByRole, getByLabelText, getByText } = render(BulkSelectionBar, {
        props: baseProps({ client: realClient() }),
      });

      await fireEvent.click(getByRole('checkbox', { name: /Select all 47 matching the filter/ }));
      const signalButton = getAllByRole('button').find(
        (button) => button.textContent?.trim() === 'Signal',
      ) as HTMLButtonElement;
      await fireEvent.click(signalButton);

      await fireEvent.input(getByLabelText('Signal name'), { target: { value: 'restart' } });
      await fireEvent.input(getByLabelText('Payload'), { target: { value: '{"force":true}' } });
      await fireEvent.click(getByRole('button', { name: 'Continue' }));

      await waitFor(() => {
        expect(getByText('2 matching workflows')).not.toBeNull();
      });
    } finally {
      fetch.restore();
    }
  });

  test('clicking Mutate tags opens the tags params form with an Add/Remove operation select', async () => {
    const { getByRole, getAllByRole, getByLabelText } = render(BulkSelectionBar, {
      props: baseProps({ client: realClient() }),
    });

    await fireEvent.click(getByRole('checkbox', { name: /Select all 47 matching the filter/ }));
    const tagsButton = getAllByRole('button').find(
      (button) => button.textContent?.trim() === 'Mutate tags',
    ) as HTMLButtonElement;
    await fireEvent.click(tagsButton);

    expect(getByLabelText('Operation')).not.toBeNull();
    expect(getByLabelText('Tags (comma-separated)')).not.toBeNull();
  });

  test('clicking Retry failed (once enabled) opens the retry dialog and fires its dry run', async () => {
    const fetch = new ScriptedFetch();
    fetch.routeJsonRpcMethod('weft.workflows.bulk.retryfailed', {
      dryRun: true,
      action: 'retryfailed',
      matched: 4,
      requestId: 'bulk:req-retry',
      scope: {
        matched: 4,
        filter: { status: 'failed' },
        statuses: ['failed'],
        workflowTypes: [],
        sampleWorkflowIds: [],
        sampleLimit: 20,
      },
      sampleWorkflowIds: [],
      confirmationToken: 'bulk:token-retry',
      confirmationTokenVersion: 1,
    });

    try {
      const { getByRole, getAllByRole, getByText } = render(BulkSelectionBar, {
        props: baseProps({ client: realClient() }),
      });

      await fireEvent.click(getByRole('checkbox', { name: /Select all 47 matching the filter/ }));
      const retryButton = getAllByRole('button').find(
        (button) => button.textContent?.trim() === 'Retry failed',
      ) as HTMLButtonElement;
      await fireEvent.click(retryButton);

      await waitFor(() => {
        expect(getByText('4 matching workflows')).not.toBeNull();
      });
    } finally {
      fetch.restore();
    }
  });

  test('clicking Delete (once enabled) opens the delete dialog and fires its dry run', async () => {
    const fetch = new ScriptedFetch();
    fetch.routeJsonRpcMethod('weft.workflows.bulk.delete', {
      dryRun: true,
      action: 'delete',
      matched: 6,
      requestId: 'bulk:req-delete',
      scope: {
        matched: 6,
        filter: { status: 'failed' },
        statuses: ['failed'],
        workflowTypes: [],
        sampleWorkflowIds: [],
        sampleLimit: 20,
      },
      sampleWorkflowIds: [],
      confirmationToken: 'bulk:token-delete',
      confirmationTokenVersion: 1,
    });

    try {
      const { getByRole, getAllByRole, getByText } = render(BulkSelectionBar, {
        props: baseProps({ client: realClient() }),
      });

      await fireEvent.click(getByRole('checkbox', { name: /Select all 47 matching the filter/ }));
      const deleteButton = getAllByRole('button').find(
        (button) => button.textContent?.trim() === 'Delete',
      ) as HTMLButtonElement;
      await fireEvent.click(deleteButton);

      await waitFor(() => {
        expect(getByText('6 matching workflows')).not.toBeNull();
      });
    } finally {
      fetch.restore();
    }
  });
});
