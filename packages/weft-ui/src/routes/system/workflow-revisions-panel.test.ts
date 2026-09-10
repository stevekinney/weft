/**
 * Component tests for `<WorkflowRevisionsPanel>` (WFT-115): data mapping,
 * permission gating, successful mutation, rejected mutation (both
 * `compatibilityReasons` and `currentGeneration`-only shapes), query
 * invalidation, and the loading/denied/malformed-response/server-fault
 * states.
 */
import { fireEvent, render, waitFor, within } from '@testing-library/svelte';
import { afterEach, describe, expect, test } from 'bun:test';

import { createQueryClient } from '../../lib/query.ts';
import { AUTHORIZATION_SCOPES } from '../../lib/scopes.svelte.ts';
import SystemRouteTestHarness from './system-route-test-harness.test-harness.svelte';
import { realClient, ScriptedFetch } from './system-test-support.test-support.ts';
import WorkflowRevisionsPanelFixture from './workflow-revisions-panel-fixture.test-harness.svelte';

let scripted: ScriptedFetch | undefined;

afterEach(() => {
  scripted?.restore();
  scripted = undefined;
});

function revisionRecord(revision: string, overrides: Record<string, unknown> = {}) {
  return {
    manifest: {
      manifestVersion: 1,
      name: 'order-processing',
      workflowVersion: '0.0.0',
      revision,
      contractHash: `sha256:${revision}-hash`,
      contract: { name: 'order-processing', workflowVersion: '0.0.0' },
    },
    installedAt: 1_700_000_000_000,
    ...overrides,
  };
}

function activePointer(revision: string, generation = 1) {
  return { revision, generation, activatedAt: 1_700_000_000_000 };
}

async function renderPanel(principalScopes?: readonly (typeof AUTHORIZATION_SCOPES)[number][]) {
  return render(SystemRouteTestHarness, {
    props: {
      client: realClient(),
      queryClient: createQueryClient(),
      component: WorkflowRevisionsPanelFixture,
      ...(principalScopes === undefined ? {} : { principalScopes }),
    },
  });
}

describe('WorkflowRevisionsPanel', () => {
  test('shows a loading state while queries are pending', async () => {
    scripted = new ScriptedFetch();
    const { getByLabelText } = await renderPanel();
    expect(getByLabelText('Loading revisions')).not.toBeNull();
  });

  test('renders the denied state without workflows:read, and calls no revisions/active operations', async () => {
    scripted = new ScriptedFetch();
    const readOnlyMinusRevisions = AUTHORIZATION_SCOPES.filter(
      (scope) => scope !== 'workflows:read',
    );
    const { findByText } = await renderPanel(readOnlyMinusRevisions);
    expect(await findByText('Requires workflows:read to view installed revisions.')).not.toBeNull();
    const catalogCalls = scripted.calls.filter(
      (call) => typeof call.init?.body === 'string' && call.init.body.includes('weft.workflows.'),
    );
    expect(catalogCalls).toHaveLength(0);
  });

  test('shows the malformed-response state when the revisions payload is not an array', async () => {
    scripted = new ScriptedFetch();
    scripted.routeJsonRpcMethod('weft.workflows.revisions.list', { not: 'an array' });
    scripted.routeJsonRpcMethod(
      'weft.workflows.active.get',
      activePointer('order-processing-rev-1'),
    );
    const { findByText } = await renderPanel();
    expect(await findByText(/revisions list this console doesn't recognize/)).not.toBeNull();
  });

  test('shows the explicit empty state when no revisions are installed', async () => {
    scripted = new ScriptedFetch();
    scripted.routeJsonRpcMethod('weft.workflows.revisions.list', []);
    scripted.routeJsonRpcError('weft.workflows.active.get', {
      code: -32020,
      message: 'never activated',
      data: { weftCode: 'NotFound', httpStatus: 404 },
    });
    const { findByText } = await renderPanel();
    expect(await findByText('No revisions installed for this workflow yet.')).not.toBeNull();
  });

  test('a revisions.list server fault renders the fault banner with a working retry', async () => {
    scripted = new ScriptedFetch();
    // `MethodNotFound` (-> the 'not-found' treatment) rather than
    // `EngineFailure`: both queries use `query.ts`'s default retry policy
    // (never overridden here, unlike e.g. `mcp-panel.svelte`'s `retry:
    // false`), which retries an `internal`-treatment fault up to 3 times
    // with backoff — genuine production behavior, but multiple seconds of
    // real backoff in a unit test. A non-retrying treatment still exercises
    // exactly the same `{:else if $revisionsQuery.isError}` branch this
    // test targets, deterministically and fast.
    scripted.routeJsonRpcError('weft.workflows.revisions.list', {
      code: -32020,
      message: 'weft.workflows.revisions.list is not available on this server',
      data: { weftCode: 'MethodNotFound', httpStatus: 404 },
    });
    scripted.routeJsonRpcMethod(
      'weft.workflows.active.get',
      activePointer('order-processing-rev-1'),
    );
    const { findByText, findByRole } = await renderPanel();
    expect(await findByText('Not found')).not.toBeNull();

    const callsBeforeRetry = scripted.calls.length;
    const retryButton = await findByRole('button', { name: /retry/i });
    await fireEvent.click(retryButton);
    await waitFor(() => {
      expect(scripted?.calls.length).toBeGreaterThan(callsBeforeRetry);
    });
  });

  test('an active.get server fault (not the never-activated NotFound case) renders the fault banner instead of silently hiding the active badge', async () => {
    scripted = new ScriptedFetch();
    scripted.routeJsonRpcMethod('weft.workflows.revisions.list', [
      revisionRecord('order-processing-rev-1'),
    ]);
    // `Forbidden` (-> the 'unauthorized' treatment, non-retrying) rather
    // than `EngineFailure` — see the sibling test above for why a
    // retryable `internal` fault is the wrong choice for a fast, focused
    // unit test of this branch. `activeQuery`'s own catch only special-
    // cases `NotFound`; every other fault code (this one included) falls
    // through to `throw error`, reaching `$activeQuery.isError` untouched.
    scripted.routeJsonRpcError('weft.workflows.active.get', {
      code: -32030,
      message: 'Caller lacks workflows:read for this workflow catalog entry',
      data: { weftCode: 'Forbidden', httpStatus: 403 },
    });
    const { findByText, findByRole, queryByText } = await renderPanel();
    expect(await findByText('Not authorized')).not.toBeNull();
    // Never silently falls back to "every row is just Installed" — the
    // fault banner replaces the row list entirely.
    expect(queryByText('Installed')).toBeNull();

    const callsBeforeRetry = scripted.calls.length;
    const retryButton = await findByRole('button', { name: /retry/i });
    await fireEvent.click(retryButton);
    await waitFor(() => {
      expect(scripted?.calls.length).toBeGreaterThan(callsBeforeRetry);
    });
  });

  test('lists installed revisions, flagging exactly one as Active and offering Activate on the rest', async () => {
    scripted = new ScriptedFetch();
    scripted.routeJsonRpcMethod('weft.workflows.revisions.list', [
      revisionRecord('order-processing-rev-1'),
      revisionRecord('order-processing-rev-2'),
    ]);
    scripted.routeJsonRpcMethod(
      'weft.workflows.active.get',
      activePointer('order-processing-rev-1'),
    );

    const { findByText, getByRole } = await renderPanel();
    expect(await findByText('Active')).not.toBeNull();
    expect(await findByText('Installed')).not.toBeNull();
    expect(getByRole('button', { name: 'Refresh' })).not.toBeNull();
    expect(getByRole('button', { name: 'Activate' })).not.toBeNull();
  });

  test('renders "no active revision" when the workflow has never been activated (active.get NotFound)', async () => {
    scripted = new ScriptedFetch();
    scripted.routeJsonRpcMethod('weft.workflows.revisions.list', [
      revisionRecord('order-processing-rev-1'),
    ]);
    scripted.routeJsonRpcError('weft.workflows.active.get', {
      code: -32020,
      message: 'Workflow "order-processing" has never been activated',
      data: { weftCode: 'NotFound', httpStatus: 404, resource: 'workflow-active-revision' },
    });

    const { findByText } = await renderPanel();
    expect(await findByText('No active revision — never activated.')).not.toBeNull();
  });

  test('Activate is disabled-with-reason without workflows:admin — never hidden', async () => {
    scripted = new ScriptedFetch();
    scripted.routeJsonRpcMethod('weft.workflows.revisions.list', [
      revisionRecord('order-processing-rev-1'),
      revisionRecord('order-processing-rev-2'),
    ]);
    scripted.routeJsonRpcMethod(
      'weft.workflows.active.get',
      activePointer('order-processing-rev-1'),
    );

    const readOnly = AUTHORIZATION_SCOPES.filter((scope) => scope !== 'workflows:admin');
    const { getByRole } = await renderPanel(readOnly);
    const activateButton = await waitFor(() => getByRole('button', { name: 'Activate' }));
    expect(activateButton.hasAttribute('disabled')).toBe(true);
    expect(activateButton.getAttribute('title')).toBe('Requires workflows:admin');
  });

  test('a successful activation shows the applied outcome and invalidates the revisions/active/registry queries', async () => {
    scripted = new ScriptedFetch();
    scripted.routeJsonRpcMethod('weft.workflows.revisions.list', [
      revisionRecord('order-processing-rev-1'),
      revisionRecord('order-processing-rev-2'),
    ]);
    scripted.routeJsonRpcMethod(
      'weft.workflows.active.get',
      activePointer('order-processing-rev-1'),
    );
    scripted.routeJsonRpcMethod('weft.workflows.revisions.activate', {
      applied: true,
      pointer: activePointer('order-processing-rev-2', 2),
    });

    const { getByRole, findByText } = await renderPanel();
    const activateButton = await waitFor(() => getByRole('button', { name: 'Activate' }));
    const callsBeforeActivation = scripted.calls.length;

    await fireEvent.click(activateButton);
    const dialog = await waitFor(() => getByRole('dialog'));
    await fireEvent.click(within(dialog).getByRole('button', { name: 'Activate' }));

    expect(await findByText('Compatible')).not.toBeNull();
    expect(await findByText(/order-processing-rev-2/)).not.toBeNull();

    // Invalidated queries refetch: at least one more call landed after the
    // mutation itself (revisions.list and/or active.get and/or the
    // registry snapshot re-fetching), proving invalidation actually fired
    // rather than asserting on internal query-client spies.
    await waitFor(() => {
      expect(scripted?.calls.length).toBeGreaterThan(callsBeforeActivation + 1);
    });
  });

  test('a refusal carrying compatibilityReasons renders every reason as explicit text, never color alone', async () => {
    scripted = new ScriptedFetch();
    scripted.routeJsonRpcMethod('weft.workflows.revisions.list', [
      revisionRecord('order-processing-rev-1'),
      revisionRecord('order-processing-rev-2'),
    ]);
    scripted.routeJsonRpcMethod(
      'weft.workflows.active.get',
      activePointer('order-processing-rev-1'),
    );
    scripted.routeJsonRpcError('weft.workflows.revisions.activate', {
      code: -32021,
      message: 'Candidate revision is incompatible with the currently active revision',
      data: {
        weftCode: 'Conflict',
        httpStatus: 409,
        reason: 'incompatible',
        compatibilityReasons: [
          'contract-hash-mismatch',
          'workflow-version-incompatible',
          'artifact-revision-mismatch',
        ],
      },
    });

    const { getByRole, findByText } = await renderPanel();
    const activateButton = await waitFor(() => getByRole('button', { name: 'Activate' }));
    await fireEvent.click(activateButton);
    const dialog = await waitFor(() => getByRole('dialog'));
    await fireEvent.click(within(dialog).getByRole('button', { name: 'Activate' }));

    expect(await findByText('Incompatible')).not.toBeNull();
    expect(await findByText(/contract-hash-mismatch/)).not.toBeNull();
    expect(await findByText(/workflow-version-incompatible/)).not.toBeNull();
    expect(await findByText(/artifact-revision-mismatch/)).not.toBeNull();
  });

  test('a refusal carrying only currentGeneration renders the stale message and a refresh action', async () => {
    scripted = new ScriptedFetch();
    scripted.routeJsonRpcMethod('weft.workflows.revisions.list', [
      revisionRecord('order-processing-rev-1'),
      revisionRecord('order-processing-rev-2'),
    ]);
    scripted.routeJsonRpcMethod(
      'weft.workflows.active.get',
      activePointer('order-processing-rev-1'),
    );
    scripted.routeJsonRpcError('weft.workflows.revisions.activate', {
      code: -32021,
      message: 'Stale expectedGeneration: the current durable generation is 4',
      data: {
        weftCode: 'Conflict',
        httpStatus: 409,
        reason: 'stale-generation',
        currentGeneration: 4,
      },
    });

    const { getByRole, findByText } = await renderPanel();
    const activateButton = await waitFor(() => getByRole('button', { name: 'Activate' }));
    await fireEvent.click(activateButton);
    const dialog = await waitFor(() => getByRole('dialog'));
    await fireEvent.click(within(dialog).getByRole('button', { name: 'Activate' }));

    expect(await findByText(/current generation 4/)).not.toBeNull();
    expect(await findByText('Conflict')).not.toBeNull();
  });

  test('a success-shaped but malformed activation response never renders an outcome banner', async () => {
    scripted = new ScriptedFetch();
    scripted.routeJsonRpcMethod('weft.workflows.revisions.list', [
      revisionRecord('order-processing-rev-1'),
      revisionRecord('order-processing-rev-2'),
    ]);
    scripted.routeJsonRpcMethod(
      'weft.workflows.active.get',
      activePointer('order-processing-rev-1'),
    );
    // `applied: true` but the `pointer` fails `isAppliedActivationResult`'s
    // structural guard — the wire lied about its own shape (or a future
    // server added a field this build doesn't understand in a way that
    // broke the pointer). Never fabricated into a "Compatible" banner.
    scripted.routeJsonRpcMethod('weft.workflows.revisions.activate', {
      applied: true,
      pointer: { revision: 'order-processing-rev-2' },
    });

    const { getByRole, queryByText, findByRole } = await renderPanel();
    const activateButton = await waitFor(() => getByRole('button', { name: 'Activate' }));
    await fireEvent.click(activateButton);
    const dialog = await waitFor(() => getByRole('dialog'));
    await fireEvent.click(within(dialog).getByRole('button', { name: 'Activate' }));

    await findByRole('button', { name: 'Activate' });
    expect(queryByText('Compatible')).toBeNull();
    expect(queryByText('Incompatible')).toBeNull();
  });

  test('a NotFound/server fault on activation routes through the existing six-code fault mapping instead of rendering an outcome banner', async () => {
    scripted = new ScriptedFetch();
    scripted.routeJsonRpcMethod('weft.workflows.revisions.list', [
      revisionRecord('order-processing-rev-1'),
      revisionRecord('order-processing-rev-2'),
    ]);
    scripted.routeJsonRpcMethod(
      'weft.workflows.active.get',
      activePointer('order-processing-rev-1'),
    );
    scripted.routeJsonRpcError('weft.workflows.revisions.activate', {
      code: -32020,
      message: 'Workflow revision "order-processing:order-processing-rev-2" was never installed',
      data: { weftCode: 'NotFound', httpStatus: 404, resource: 'workflow-revision' },
    });

    const { getByRole, queryByText, findByRole } = await renderPanel();
    const activateButton = await waitFor(() => getByRole('button', { name: 'Activate' }));
    await fireEvent.click(activateButton);
    const dialog = await waitFor(() => getByRole('dialog'));
    await fireEvent.click(within(dialog).getByRole('button', { name: 'Activate' }));

    // The mutation settles (button returns to its normal, non-pending state)
    // without ever rendering one of the recognized outcome banners — a
    // NotFound refusal isn't a compatibility verdict this panel understands,
    // so it is rethrown and handled by the default mutation-error toast
    // (query.ts), not fabricated into a local outcome.
    await findByRole('button', { name: 'Activate' });
    expect(queryByText('Compatible')).toBeNull();
    expect(queryByText('Incompatible')).toBeNull();
  });

  test('the stale-outcome Refresh button refetches revisions and the active pointer', async () => {
    scripted = new ScriptedFetch();
    scripted.routeJsonRpcMethod('weft.workflows.revisions.list', [
      revisionRecord('order-processing-rev-1'),
      revisionRecord('order-processing-rev-2'),
    ]);
    scripted.routeJsonRpcMethod(
      'weft.workflows.active.get',
      activePointer('order-processing-rev-1'),
    );
    scripted.routeJsonRpcError('weft.workflows.revisions.activate', {
      code: -32021,
      message: 'Stale expectedGeneration: the current durable generation is 4',
      data: {
        weftCode: 'Conflict',
        httpStatus: 409,
        reason: 'stale-generation',
        currentGeneration: 4,
      },
    });

    const { getByRole, findByText, getAllByRole } = await renderPanel();
    const activateButton = await waitFor(() => getByRole('button', { name: 'Activate' }));
    await fireEvent.click(activateButton);
    const dialog = await waitFor(() => getByRole('dialog'));
    await fireEvent.click(within(dialog).getByRole('button', { name: 'Activate' }));
    await findByText(/current generation 4/);

    const callsBeforeRefresh = scripted.calls.length;
    // Two "Refresh" buttons now exist: the active row's own Refresh action
    // and the stale-outcome banner's Refresh action — the LAST one rendered
    // is the outcome banner's (it renders after the row list in document
    // order).
    const refreshButtons = getAllByRole('button', { name: 'Refresh' });
    const outcomeRefresh = refreshButtons[refreshButtons.length - 1];
    if (outcomeRefresh) await fireEvent.click(outcomeRefresh);

    await waitFor(() => {
      expect(scripted?.calls.length).toBeGreaterThan(callsBeforeRefresh);
    });
  });

  test('activating the already-active revision (labeled Refresh) opens the confirm dialog and applies', async () => {
    scripted = new ScriptedFetch();
    scripted.routeJsonRpcMethod('weft.workflows.revisions.list', [
      revisionRecord('order-processing-rev-1'),
      revisionRecord('order-processing-rev-2'),
      revisionRecord('order-processing-rev-3'),
    ]);
    scripted.routeJsonRpcMethod(
      'weft.workflows.active.get',
      activePointer('order-processing-rev-1', 3),
    );
    scripted.routeJsonRpcMethod('weft.workflows.revisions.activate', {
      applied: true,
      pointer: activePointer('order-processing-rev-1', 4),
    });

    const { getByRole, findByText } = await renderPanel();
    const refreshButton = await waitFor(() => getByRole('button', { name: 'Refresh' }));
    await fireEvent.click(refreshButton);
    const dialog = await waitFor(() => getByRole('dialog'));
    await fireEvent.click(within(dialog).getByRole('button', { name: 'Activate' }));

    expect(await findByText('Compatible')).not.toBeNull();
  });
});
