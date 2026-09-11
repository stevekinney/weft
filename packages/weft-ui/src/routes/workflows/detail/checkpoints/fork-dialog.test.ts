import { fireEvent, render, waitFor } from '@testing-library/svelte';
import { describe, expect, test } from 'bun:test';

import { HttpClientError } from '@lostgradient/weft/client';
import { QueryClient } from '@tanstack/svelte-query';

import { AUTHORIZATION_SCOPES, type Principal } from '../../../../lib/scopes.svelte.ts';
import ForkDialogHarness from './fork-dialog.test-harness.svelte';

function allScopesPrincipal(): Principal {
  return { scopes: AUTHORIZATION_SCOPES, unauthenticatedAccess: null };
}

function deniedPrincipal(): Principal {
  return { scopes: [], unauthenticatedAccess: null };
}

function newQueryClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function installedRevisionRecord(revision: string, installedAt: number) {
  return {
    manifest: { manifestVersion: 1, name: 'order-processing', workflowVersion: '1.0.0', revision },
    installedAt,
  };
}

function baseClient(
  overrides: { fork?: (id: string, options?: unknown) => Promise<{ readonly id: string }> } = {},
) {
  return {
    fork: overrides.fork ?? (async () => ({ id: 'wf-forked-1' })),
    operations: {
      'weft.workflows.revisions.list': async () => [
        installedRevisionRecord('order-processing-rev-a', 1_000),
        installedRevisionRecord('order-processing-rev-b', 2_000),
      ],
    },
  };
}

describe('ForkDialog', () => {
  test('default state shows "Retains rev X" for a run with a persisted source revision', async () => {
    const { getByText } = render(ForkDialogHarness, {
      props: {
        client: baseClient(),
        workflowId: 'wf-1',
        initialStep: 3,
        workflowType: 'order-processing',
        sourceRevision: 'order-processing-rev-current',
        principal: allScopesPrincipal(),
        queryClient: newQueryClient(),
      },
    });

    expect(getByText(/^Retains/)).not.toBeNull();
  });

  test('default state shows the unpinned-legacy variant when sourceRevision is undefined', async () => {
    const { getByText } = render(ForkDialogHarness, {
      props: {
        client: baseClient(),
        workflowId: 'wf-1',
        initialStep: 3,
        workflowType: 'order-processing',
        sourceRevision: undefined,
        principal: allScopesPrincipal(),
        queryClient: newQueryClient(),
      },
    });

    expect(getByText(/^Unpinned source/)).not.toBeNull();
  });

  test('the picker disclosure lists installed revisions when workflows:read is granted', async () => {
    const { getByRole, getByText } = render(ForkDialogHarness, {
      props: {
        client: baseClient(),
        workflowId: 'wf-1',
        initialStep: 3,
        workflowType: 'order-processing',
        sourceRevision: 'order-processing-rev-current',
        principal: allScopesPrincipal(),
        queryClient: newQueryClient(),
      },
    });

    await fireEvent.click(getByRole('button', { name: 'Fork a different revision' }));

    await waitFor(() => {
      expect(getByText(/rev order-pr…ev-a/)).not.toBeNull();
      expect(getByText(/rev order-pr…ev-b/)).not.toBeNull();
    });
  });

  test('the picker degrades to a free-text input with an explanatory note when workflows:read is denied', async () => {
    const { getByRole, getByText } = render(ForkDialogHarness, {
      props: {
        client: baseClient(),
        workflowId: 'wf-1',
        initialStep: 3,
        workflowType: 'order-processing',
        sourceRevision: 'order-processing-rev-current',
        principal: deniedPrincipal(),
        queryClient: newQueryClient(),
      },
    });

    await fireEvent.click(getByRole('button', { name: 'Fork a different revision' }));

    await waitFor(() => {
      expect(getByRole('textbox', { name: 'Revision id' })).not.toBeNull();
      expect(getByText(/don't have permission to list installed revisions/)).not.toBeNull();
    });
  });

  test('submitting with an explicit revision passes {fromStep, revision} to client.fork', async () => {
    const forkCalls: unknown[] = [];
    const client = baseClient({
      fork: async (_id, options) => {
        forkCalls.push(options);
        return { id: 'wf-forked-1' };
      },
    });

    const { getByRole } = render(ForkDialogHarness, {
      props: {
        client,
        workflowId: 'wf-1',
        initialStep: 3,
        workflowType: 'order-processing',
        sourceRevision: 'order-processing-rev-current',
        principal: deniedPrincipal(),
        queryClient: newQueryClient(),
      },
    });

    await fireEvent.click(getByRole('button', { name: 'Fork a different revision' }));
    const input = getByRole('textbox', { name: 'Revision id' });
    await fireEvent.input(input, { target: { value: 'order-processing-rev-explicit' } });
    await fireEvent.click(getByRole('button', { name: 'Create fork' }));

    await waitFor(() => {
      expect(forkCalls).toEqual([{ fromStep: 3, revision: 'order-processing-rev-explicit' }]);
    });
  });

  test('a WorkflowRevisionUnavailableError-coded rejection renders the Conflict-specific "pick a different revision" framing', async () => {
    const client = baseClient({
      fork: async () => {
        throw new HttpClientError(409, 'revision not registered', {
          faultCode: 'Conflict',
          weftCode: 'WorkflowRevisionUnavailableError',
        });
      },
    });

    const { getByRole, getByText } = render(ForkDialogHarness, {
      props: {
        client,
        workflowId: 'wf-1',
        initialStep: 3,
        workflowType: 'order-processing',
        sourceRevision: 'order-processing-rev-current',
        principal: deniedPrincipal(),
        queryClient: newQueryClient(),
      },
    });

    await fireEvent.click(getByRole('button', { name: 'Create fork' }));

    await waitFor(() => {
      expect(getByText('Revision unavailable')).not.toBeNull();
      expect(getByText(/Pick a different revision/)).not.toBeNull();
    });
  });

  test('any other error keeps the existing generic-error paragraph', async () => {
    const client = baseClient({
      fork: async () => {
        throw new HttpClientError(500, 'internal engine failure', { faultCode: 'EngineFailure' });
      },
    });

    const { getByRole, getByText, queryByText } = render(ForkDialogHarness, {
      props: {
        client,
        workflowId: 'wf-1',
        initialStep: 3,
        workflowType: 'order-processing',
        sourceRevision: 'order-processing-rev-current',
        principal: deniedPrincipal(),
        queryClient: newQueryClient(),
      },
    });

    await fireEvent.click(getByRole('button', { name: 'Create fork' }));

    await waitFor(() => {
      expect(getByText('internal engine failure')).not.toBeNull();
    });
    expect(queryByText('Revision unavailable')).toBeNull();
  });
});
