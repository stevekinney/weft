import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { DetachedWindowAPI } from 'happy-dom';

import { QueryClient } from '@tanstack/svelte-query';
import { fireEvent, render, waitFor } from '@testing-library/svelte';

import { router } from '../../../lib/router.svelte.ts';
import type { Principal } from '../../../lib/scopes.svelte.ts';
import { realClient, ScriptedFetch } from '../list/workflow-test-support.test-support.ts';
import WorkflowDetailHarness from './workflow-detail.test-harness.svelte';

function baseWorkflow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'wf-detail-1',
    type: 'order-fulfillment',
    status: 'running',
    input: {},
    versionTuple: { workflowVersion: '1.0.0' },
    createdAt: 1_000,
    updatedAt: 1_000,
    ...overrides,
  };
}

const GRANTED_PRINCIPAL: Principal = {
  scopes: ['workflows:read'],
  unauthenticatedAccess: null,
};

function resetLocation(path: string): void {
  (window as unknown as { happyDOM: DetachedWindowAPI }).happyDOM.setURL('http://localhost/');
  router.navigate(path, { replace: true });
}

function newQueryClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

let fetchScript: ScriptedFetch;

beforeEach(() => {
  fetchScript = new ScriptedFetch();
  // `WorkflowDetail` subscribes to the shared fleet feed unconditionally on
  // mount (module doc: "Fleet liveness" / `WorkflowLiveObservations`) — the
  // stream must stay open (never a finite/closed response) or
  // `FleetEventSource` reconnects in a loop (`routeSseStream` module doc).
  fetchScript.routeSseStream('/v1/events/sse');
});

afterEach(() => {
  fetchScript.restore();
});

describe('WorkflowDetail — not-found state', () => {
  test('a missing workflow id renders a named next step, not bare text', async () => {
    const bogusId = '00000000-0000-0000-0000-000000000000';
    // `HttpClient.get()` resolves a 404 GET to `null` rather than throwing
    // (weft's `request()` — see `workflow-detail.svelte`'s `notFound` derivation).
    fetchScript.routeUrlStatus(`/workflows/${bogusId}`, 404);
    resetLocation(`/workflows/${bogusId}`);

    const { findByText, queryByText } = render(WorkflowDetailHarness, {
      props: { client: realClient(), principal: GRANTED_PRINCIPAL, queryClient: newQueryClient() },
    });

    expect(await findByText('No workflow found')).not.toBeNull();
    expect(queryByText(`No workflow found with id ${bogusId}.`)).toBeNull();

    const backLink = await findByText('Back to workflows');
    expect(backLink.closest('a')?.getAttribute('href')).toBe(router.href('/workflows'));
  });
});

describe('WorkflowDetail — fault state', () => {
  test('a 500 from the workflow fetch renders the internal-fault treatment', async () => {
    const id = 'wf-detail-fault-1';
    fetchScript.routeUrlStatus(`/workflows/${id}`, 500);
    resetLocation(`/workflows/${id}`);

    const { findByRole } = render(WorkflowDetailHarness, {
      props: { client: realClient(), principal: GRANTED_PRINCIPAL, queryClient: newQueryClient() },
    });

    const alert = await findByRole('alert');
    expect(alert).not.toBeNull();
  });
});

describe('WorkflowDetail — loaded workflow', () => {
  test('renders the header and Overview tab by default, and switches tabs', async () => {
    const id = 'wf-detail-loaded-1';
    // Registered before the base workflow route: `ScriptedFetch.routeUrl`
    // matches by substring in registration order, and `/workflows/:id/events`
    // is itself a substring match for the base `/workflows/:id` route too.
    fetchScript.routeUrl(`/workflows/${id}/events`, []);
    fetchScript.routeUrl(`/workflows/${id}`, baseWorkflow({ id }));
    resetLocation(`/workflows/${id}`);

    const { findByRole, getByRole } = render(WorkflowDetailHarness, {
      props: { client: realClient(), principal: GRANTED_PRINCIPAL, queryClient: newQueryClient() },
    });

    // "order-fulfillment" also appears in the Overview tab's own Definition
    // list ({ term: 'Type', definition: workflow.type }) — scope to the
    // header's heading specifically.
    expect(await findByRole('heading', { name: 'order-fulfillment' })).not.toBeNull();
    expect(getByRole('tab', { name: 'Overview', selected: true })).not.toBeNull();

    await fireEvent.click(getByRole('tab', { name: 'Events' }));

    await waitFor(() => {
      expect(getByRole('tab', { name: 'Events', selected: true })).not.toBeNull();
    });

    // Tab selection syncs into the URL's ?tab= query parameter.
    expect(router.search.get('tab')).toBe('events');
  });

  test('the URL tab query parameter drives the initially active tab', async () => {
    const id = 'wf-detail-loaded-2';
    fetchScript.routeUrl(`/workflows/${id}/events`, []);
    fetchScript.routeUrl(`/workflows/${id}`, baseWorkflow({ id }));
    resetLocation(`/workflows/${id}?tab=events`);

    const { findByRole } = render(WorkflowDetailHarness, {
      props: { client: realClient(), principal: GRANTED_PRINCIPAL, queryClient: newQueryClient() },
    });

    expect(await findByRole('tab', { name: 'Events', selected: true })).not.toBeNull();
  });

  test('clicking Suspend calls the suspend endpoint and clears the pending state', async () => {
    const id = 'wf-detail-suspend-1';
    fetchScript.routeUrl(`/workflows/${id}/suspend`, {});
    fetchScript.routeUrl(`/workflows/${id}`, baseWorkflow({ id, status: 'running' }));
    resetLocation(`/workflows/${id}`);

    const { findByRole, getByRole } = render(WorkflowDetailHarness, {
      props: { client: realClient(), principal: GRANTED_PRINCIPAL, queryClient: newQueryClient() },
    });

    const suspendButton = await findByRole('button', { name: 'Suspend' });
    await fireEvent.click(suspendButton);

    await waitFor(() => {
      expect(fetchScript.calls.some((call) => call.url.includes(`/workflows/${id}/suspend`))).toBe(
        true,
      );
    });
    await waitFor(() => {
      expect(getByRole('button', { name: 'Suspend' }).hasAttribute('disabled')).toBe(false);
    });
  });

  test('a cancelled workflow enables and renders the finalizer-backed header badge', async () => {
    const id = 'wf-detail-finalizer-1';
    fetchScript.routeUrl(`/workflows/${id}`, baseWorkflow({ id, status: 'cancelled' }));
    fetchScript.routeJsonRpcMethod('weft.workflows.finalizer.get', {
      status: 'running',
      attempts: 1,
      startedAt: 1,
    });
    resetLocation(`/workflows/${id}`);

    const { findByText } = render(WorkflowDetailHarness, {
      props: { client: realClient(), principal: GRANTED_PRINCIPAL, queryClient: newQueryClient() },
    });

    expect(await findByText('Finalizing')).not.toBeNull();
  });
});
