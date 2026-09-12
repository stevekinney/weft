/**
 * Component tests for `<DynamicSourcePanel>` (WFT-116): the lookup form's
 * empty/stale states, the `workflows:admin` gate on Preload, concurrent-
 * submission deduplication, every preload outcome the bounded fault set
 * produces, and the query invalidation each outcome performs.
 */
import { fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, test } from 'bun:test';

import { createQueryClient } from '../../lib/query.ts';
import { AUTHORIZATION_SCOPES } from '../../lib/scopes.svelte.ts';
import DynamicSourcePanel from './dynamic-source-panel.svelte';
import SystemRouteTestHarness from './system-route-test-harness.test-harness.svelte';
import { realClient, ScriptedFetch } from './system-test-support.test-support.ts';

const DIAGNOSTICS = 'weft.catalog.diagnostics';
const PRELOAD = 'weft.workflows.revisions.preload';

const NAME = 'invoice-reconciliation';
const REVISION = 'invoice-reconciliation-r1';

function idleDiagnostics() {
  return {
    name: NAME,
    revision: REVISION,
    installed: false,
    active: false,
    references: {},
    removable: false,
    source: { kind: 'module', requestedRevision: REVISION, state: 'idle', waiterCount: 0 },
  };
}

async function renderPanel(principalScopes?: readonly (typeof AUTHORIZATION_SCOPES)[number][]) {
  return render(SystemRouteTestHarness, {
    props: {
      client: realClient(),
      queryClient: createQueryClient(),
      component: DynamicSourcePanel,
      ...(principalScopes === undefined ? {} : { principalScopes }),
    },
  });
}

/** Fills both inputs and submits the lookup, leaving the result region rendered. */
async function inspect(
  container: HTMLElement,
  getByRole: (role: string, options: { name: string | RegExp }) => HTMLElement,
  name = NAME,
  revision = REVISION,
): Promise<void> {
  const nameInput = container.querySelector('#weft-dynamic-source-name');
  const revisionInput = container.querySelector('#weft-dynamic-source-revision');
  if (!(nameInput instanceof HTMLInputElement) || !(revisionInput instanceof HTMLInputElement)) {
    throw new Error('lookup inputs not rendered');
  }
  await fireEvent.input(nameInput, { target: { value: name } });
  await fireEvent.input(revisionInput, { target: { value: revision } });
  await fireEvent.click(getByRole('button', { name: 'Inspect' }));
}

let scripted: ScriptedFetch | undefined;

afterEach(() => {
  scripted?.restore();
  scripted = undefined;
});

describe('DynamicSourcePanel', () => {
  test('starts empty, explaining that both fields are required and why', async () => {
    scripted = new ScriptedFetch();
    const { findByText, getByRole } = await renderPanel();

    expect(await findByText(/No source inspected yet/)).not.toBeNull();
    expect((getByRole('button', { name: 'Inspect' }) as HTMLButtonElement).disabled).toBe(true);
  });

  test('says plainly that Weft cannot list registered sources', async () => {
    scripted = new ScriptedFetch();
    const { findByText } = await renderPanel();
    expect(await findByText(/Weft exposes no way to list registered sources/)).not.toBeNull();
  });

  test('renders the submitted key’s diagnostics after Inspect', async () => {
    scripted = new ScriptedFetch();
    scripted.routeJsonRpcMethod(DIAGNOSTICS, idleDiagnostics());
    const { container, getByRole, findByText } = await renderPanel();

    await inspect(container, getByRole);
    expect(await findByText('Load state: Idle')).not.toBeNull();
  });

  test('flags the rendered result as stale once the inputs no longer match it', async () => {
    scripted = new ScriptedFetch();
    scripted.routeJsonRpcMethod(DIAGNOSTICS, idleDiagnostics());
    const { container, getByRole, findByText } = await renderPanel();

    await inspect(container, getByRole);
    await findByText('Load state: Idle');

    const revisionInput = container.querySelector('#weft-dynamic-source-revision');
    if (!(revisionInput instanceof HTMLInputElement)) throw new Error('revision input missing');
    await fireEvent.input(revisionInput, { target: { value: 'something-else' } });

    expect(await findByText(/Showing the last inspected key/)).not.toBeNull();
  });

  test('disables Preload without workflows:admin', async () => {
    scripted = new ScriptedFetch();
    scripted.routeJsonRpcMethod(DIAGNOSTICS, idleDiagnostics());
    const withoutAdmin = AUTHORIZATION_SCOPES.filter((scope) => scope !== 'workflows:admin');
    const { container, getByRole, findByText } = await renderPanel(withoutAdmin);

    await inspect(container, getByRole);
    await findByText('Load state: Idle');

    expect((getByRole('button', { name: 'Preload' }) as HTMLButtonElement).disabled).toBe(true);
  });

  test('reports a successful preload and invalidates the catalog queries', async () => {
    scripted = new ScriptedFetch();
    scripted.routeJsonRpcMethod(DIAGNOSTICS, idleDiagnostics());
    scripted.routeJsonRpcMethod(PRELOAD, {
      manifest: { revision: REVISION, name: NAME },
      installedAt: 1_700_000_000_000,
    });
    const { container, getByRole, findByText } = await renderPanel();

    await inspect(container, getByRole);
    await findByText('Load state: Idle');
    await fireEvent.click(getByRole('button', { name: 'Preload' }));

    expect(await findByText(/is installed in the workflow catalog/)).not.toBeNull();
    expect(await findByText(/describe the responding engine process/)).not.toBeNull();
    // The diagnostics key is invalidated on every settled outcome, so the
    // operation is called again after the mutation resolves.
    await waitFor(() => {
      const diagnosticsCalls = (scripted?.calls ?? []).filter(
        (call) => typeof call.init?.body === 'string' && call.init.body.includes(DIAGNOSTICS),
      );
      expect(diagnosticsCalls.length).toBeGreaterThan(1);
    });
  });

  test('deduplicates concurrent submissions by disabling the control while pending', async () => {
    scripted = new ScriptedFetch();
    scripted.routeJsonRpcMethod(DIAGNOSTICS, idleDiagnostics());
    scripted.routeJsonRpcMethod(PRELOAD, {
      manifest: { revision: REVISION, name: NAME },
      installedAt: 1,
    });
    const { container, getByRole, findByText } = await renderPanel();

    await inspect(container, getByRole);
    await findByText('Load state: Idle');

    const button = getByRole('button', { name: 'Preload' }) as HTMLButtonElement;
    await fireEvent.click(button);
    await fireEvent.click(button);
    await fireEvent.click(button);

    await findByText(/is installed in the workflow catalog/);
    const preloadCalls = scripted.calls.filter(
      (call) => typeof call.init?.body === 'string' && call.init.body.includes(PRELOAD),
    );
    expect(preloadCalls).toHaveLength(1);
  });

  test('explains a NotFound refusal for a key with no registered source', async () => {
    scripted = new ScriptedFetch();
    scripted.routeJsonRpcMethod(DIAGNOSTICS, idleDiagnostics());
    scripted.routeJsonRpcError(PRELOAD, {
      code: -32000,
      message: 'no source',
      data: { httpStatus: 404, weftCode: 'NotFound', resource: 'workflow-source' },
    });
    const { container, getByRole, findByText } = await renderPanel();

    await inspect(container, getByRole);
    await findByText('Load state: Idle');
    await fireEvent.click(getByRole('button', { name: 'Preload' }));

    expect(await findByText(/No dynamic workflow source is registered/)).not.toBeNull();
  });

  test('revokes workflows:admin locally when a preload is forbidden, so the control stops inviting it', async () => {
    scripted = new ScriptedFetch();
    scripted.routeJsonRpcMethod(DIAGNOSTICS, idleDiagnostics());
    scripted.routeJsonRpcError(PRELOAD, {
      code: -32000,
      message: 'forbidden',
      data: { httpStatus: 403, weftCode: 'Forbidden' },
    });
    const { container, getByRole, findByText } = await renderPanel();

    await inspect(container, getByRole);
    await findByText('Load state: Idle');
    expect((getByRole('button', { name: 'Preload' }) as HTMLButtonElement).disabled).toBe(false);

    await fireEvent.click(getByRole('button', { name: 'Preload' }));
    await findByText(/not allowed to preload workflow revisions/);

    // Without the local revoke, `adminGate` stays enabled and keeps inviting a
    // request the server will reject for the rest of the session.
    await waitFor(() => {
      expect((getByRole('button', { name: 'Preload' }) as HTMLButtonElement).disabled).toBe(true);
    });
  });

  test('renders a load-failed conflict with its bounded reason and no invented cause', async () => {
    scripted = new ScriptedFetch();
    scripted.routeJsonRpcMethod(DIAGNOSTICS, idleDiagnostics());
    scripted.routeJsonRpcError(PRELOAD, {
      code: -32000,
      message: 'failed to load',
      data: { httpStatus: 409, weftCode: 'Conflict', reason: 'load-failed' },
    });
    const { container, getByRole, findByText } = await renderPanel();

    await inspect(container, getByRole);
    await findByText('Load state: Idle');
    await fireEvent.click(getByRole('button', { name: 'Preload' }));

    expect(await findByText('Refused: load-failed')).not.toBeNull();
    expect(await findByText(/bounded failure category/)).not.toBeNull();
  });

  test('lists every source-validation reason a validation-failed conflict carries', async () => {
    scripted = new ScriptedFetch();
    scripted.routeJsonRpcMethod(DIAGNOSTICS, idleDiagnostics());
    scripted.routeJsonRpcError(PRELOAD, {
      code: -32000,
      message: 'invalid',
      data: {
        httpStatus: 409,
        weftCode: 'Conflict',
        reason: 'validation-failed',
        sourceValidationReasons: ['missing-export', 'artifact-revision-mismatch'],
      },
    });
    const { container, getByRole, findByText } = await renderPanel();

    await inspect(container, getByRole);
    await findByText('Load state: Idle');
    await fireEvent.click(getByRole('button', { name: 'Preload' }));

    expect(await findByText(/missing-export/)).not.toBeNull();
    expect(await findByText(/artifact-revision-mismatch/)).not.toBeNull();
  });

  test('reports a rejected InvalidParams mutation with the field the server named', async () => {
    scripted = new ScriptedFetch();
    scripted.routeJsonRpcMethod(DIAGNOSTICS, idleDiagnostics());
    scripted.routeJsonRpcError(PRELOAD, {
      code: -32602,
      message: 'Field "revision" must be a non-empty string',
      data: { httpStatus: 400, weftCode: 'InvalidParams' },
    });
    const { container, getByRole, findByText } = await renderPanel();

    await inspect(container, getByRole);
    await findByText('Load state: Idle');
    await fireEvent.click(getByRole('button', { name: 'Preload' }));

    expect(await findByText(/Field "revision"/)).not.toBeNull();
  });

  test('reports a server fault without claiming the revision installed', async () => {
    scripted = new ScriptedFetch();
    scripted.routeJsonRpcMethod(DIAGNOSTICS, idleDiagnostics());
    scripted.routeJsonRpcError(PRELOAD, {
      code: -32000,
      message: 'internal error',
      data: { httpStatus: 500, weftCode: 'EngineFailure' },
    });
    const { container, getByRole, findByText } = await renderPanel();

    await inspect(container, getByRole);
    await findByText('Load state: Idle');
    await fireEvent.click(getByRole('button', { name: 'Preload' }));

    expect(await findByText(/could not preload/)).not.toBeNull();
  });

  test('never renders a preload outcome under a different key’s identity badges', async () => {
    // Regression guard: `onSuccess` used to write the outcome unconditionally.
    // An operator can inspect a different key while a preload is still in
    // flight, and the earlier key's outcome would then land under the new
    // key's badges, reading as a result for a revision never preloaded.
    scripted = new ScriptedFetch();
    scripted.routeJsonRpcMethod(DIAGNOSTICS, idleDiagnostics());

    // Hold the preload open until the test releases it, so the key can be
    // switched while it is genuinely in flight.
    let releasePreload!: () => void;
    const preloadHeld = new Promise<void>((resolve) => {
      releasePreload = resolve;
    });
    scripted.routeJsonRpcDeferred(
      PRELOAD,
      preloadHeld.then(() => ({
        manifest: { revision: REVISION, name: NAME },
        installedAt: 1,
      })),
    );

    const { container, getByRole, findByText, queryByText } = await renderPanel();

    await inspect(container, getByRole);
    await findByText('Load state: Idle');
    await fireEvent.click(getByRole('button', { name: 'Preload' }));

    // The initial diagnostics response is idle. Starting this slow preload
    // must still switch the mounted query to the fast cadence immediately,
    // otherwise it would wait the settled 30-second interval before seeing
    // the server's loading state. The third call proves the 2-second cadence,
    // rather than only the immediate refresh.
    await waitFor(
      () => {
        const diagnosticsCalls = scripted!.calls.filter(
          (call) => typeof call.init?.body === 'string' && call.init.body.includes(DIAGNOSTICS),
        );
        expect(diagnosticsCalls.length).toBeGreaterThan(2);
      },
      { timeout: 2_500 },
    );

    // Switch to a different revision while the first preload is unresolved.
    await inspect(container, getByRole, NAME, 'a-different-revision');
    await findByText('Load state: Idle');

    const preloadButton = () => getByRole('button', { name: /Preload/ }) as HTMLButtonElement;
    expect(preloadButton().disabled).toBe(true);

    releasePreload();

    // Wait for PROOF the mutation settled, not merely for a quiet moment: an
    // `expect(...).toBeNull()` inside `waitFor` passes on its very first
    // check, before a late write could possibly have landed, which would make
    // this test vacuous (it did, in an earlier revision of it). `onSettled`
    // clears the in-flight key, re-enabling the button — an observable edge
    // that fires on both the fixed and the broken code, so the outcome
    // assertion below is what actually distinguishes them.
    //
    // The settled key's diagnostics invalidation is NOT a usable signal here:
    // that query is no longer mounted, and TanStack Query does not refetch an
    // inactive key on invalidation.
    await waitFor(() => {
      expect(preloadButton().disabled).toBe(false);
    });

    // The settled outcome belongs to the FIRST key, which is no longer shown.
    expect(queryByText(/is installed in the workflow catalog/)).toBeNull();
  });

  test('round-trips an opaque CR/LF revision through the escaped JSON-string mode', async () => {
    scripted = new ScriptedFetch();
    scripted.routeJsonRpcMethod(DIAGNOSTICS, idleDiagnostics());
    scripted.routeJsonRpcMethod(PRELOAD, { manifest: { revision: 'line\r\nrevision' } });
    const { container, getByRole, findByText } = await renderPanel();

    const nameInput = container.querySelector('#weft-dynamic-source-name');
    const revisionInput = container.querySelector('#weft-dynamic-source-revision');
    const escapedRevision = '"line\\r\\nrevision"';
    if (!(nameInput instanceof HTMLInputElement) || !(revisionInput instanceof HTMLInputElement)) {
      throw new Error('lookup inputs not rendered');
    }
    await fireEvent.input(nameInput, { target: { value: NAME } });
    await fireEvent.click(container.querySelector('#weft-dynamic-source-revision-json')!);
    await fireEvent.input(revisionInput, { target: { value: escapedRevision } });
    await fireEvent.click(getByRole('button', { name: 'Inspect' }));

    expect(await findByText('Load state: Idle')).not.toBeNull();
    const diagnosticsCall = scripted.calls.find(
      (call) => typeof call.init?.body === 'string' && call.init.body.includes(DIAGNOSTICS),
    );
    expect(JSON.parse(diagnosticsCall!.init!.body as string).params.revision).toBe(
      'line\r\nrevision',
    );
    await fireEvent.click(getByRole('button', { name: 'Preload' }));
    await findByText(/is installed in the workflow catalog/);
    const preloadCall = scripted.calls.find(
      (call) => typeof call.init?.body === 'string' && call.init.body.includes(PRELOAD),
    );
    expect(JSON.parse(preloadCall!.init!.body as string).params.revision).toBe('line\r\nrevision');
  });

  test.each(['not JSON', '42', 'null', '""'])(
    'does not submit an invalid or empty JSON-string revision: %s',
    async (revision) => {
      scripted = new ScriptedFetch();
      const { container, getByRole } = await renderPanel();
      await fireEvent.click(container.querySelector('#weft-dynamic-source-revision-json')!);
      await inspect(container, getByRole, NAME, revision);
      expect((getByRole('button', { name: 'Inspect' }) as HTMLButtonElement).disabled).toBe(true);
      expect(scripted.calls).toHaveLength(0);
    },
  );

  test('clears a previous outcome when a different key is inspected', async () => {
    scripted = new ScriptedFetch();
    scripted.routeJsonRpcMethod(DIAGNOSTICS, idleDiagnostics());
    scripted.routeJsonRpcError(PRELOAD, {
      code: -32000,
      message: 'failed to load',
      data: { httpStatus: 409, weftCode: 'Conflict', reason: 'load-failed' },
    });
    const { container, getByRole, findByText, queryByText } = await renderPanel();

    await inspect(container, getByRole);
    await findByText('Load state: Idle');
    await fireEvent.click(getByRole('button', { name: 'Preload' }));
    await findByText('Refused: load-failed');

    await inspect(container, getByRole, NAME, 'another-revision');
    await waitFor(() => {
      expect(queryByText('Refused: load-failed')).toBeNull();
    });
  });
});
