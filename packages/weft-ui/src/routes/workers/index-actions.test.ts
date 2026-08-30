/**
 * Component tests for the Workers route root (`index.svelte`, plan §9.4)
 * covering the happy-path tab renders, worker/queue selection via URL,
 * drain/resume mutations, dead-letter clearing, and loading skeletons.
 * Split out of `index.test.ts` (which owns the fault-title-mapping
 * regression coverage) purely to stay under this repo's `max-lines` lint
 * budget — both files exercise the same `index.svelte` route root and share
 * the same `ScriptedFetch`/harness support (`workers-route-test-support.test-support.ts`,
 * `workers-route-test-harness.test-harness.svelte`).
 */
import { fireEvent, render } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { DetachedWindowAPI } from 'happy-dom';

import { createQueryClient } from '../../lib/query.ts';
import { router } from '../../lib/router.svelte.ts';
import WorkersRoute from './index.svelte';
import type {
  StandardTaskDiagnosticItem,
  TaskDiagnosticItem,
  TaskDiagnosticsSummary,
  TaskQueueHealth,
  WorkerDeploymentSummary,
  WorkerSummary,
} from './worker-catalog-types.ts';
import WorkersRouteTestHarness from './workers-route-test-harness.test-harness.svelte';
import {
  realClient,
  ScriptedFetch,
  taskLedgerDetailFixture,
} from './workers-route-test-support.test-support.ts';

function worker(overrides: Partial<WorkerSummary> = {}): WorkerSummary {
  return {
    id: 'wkr_1',
    queue: 'default',
    activities: ['Workflow.activity'],
    concurrency: 4,
    inFlight: 1,
    availableCapacity: 3,
    connectedAt: 0,
    lastHeartbeatAt: 0,
    startedAt: 0,
    heartbeatAgeMs: 1_000,
    capabilities: {},
    health: 'active',
    ...overrides,
  };
}

function deployment(overrides: Partial<WorkerDeploymentSummary> = {}): WorkerDeploymentSummary {
  return {
    activeWorkers: 1,
    buildId: '#4821',
    deploymentName: 'api-prod',
    drainedWorkers: 0,
    drainingWorkers: 0,
    health: 'active',
    inFlight: 1,
    oldestStartedAt: null,
    runtimeVersion: 'node 20',
    workers: 1,
    ...overrides,
  };
}

function queue(overrides: Partial<TaskQueueHealth> = {}): TaskQueueHealth {
  return {
    queue: 'default',
    backlog: 0,
    oldestEnqueuedAt: null,
    oldestQueuedAgeMs: null,
    waitingPollers: 0,
    schedulingPolicy: 'priority',
    inFlight: 0,
    connectedWorkers: 1,
    ...overrides,
  };
}

function diagnosticItem(
  overrides: Partial<StandardTaskDiagnosticItem> = {},
): StandardTaskDiagnosticItem {
  return {
    kind: 'dead-lettered',
    state: 'dead-lettered',
    retryCount: 5,
    requeueCount: 5,
    evidence: ['exhausted retries'],
    operationId: 'op_dead_1',
    activityName: 'ChargeCard',
    queue: 'default',
    deadLetteredAt: 1_700_000_000_000,
    ...overrides,
  };
}

const EMPTY_DIAGNOSTICS_SUMMARY: TaskDiagnosticsSummary = {
  stuckQueued: 0,
  staleInflight: 0,
  retryStorms: 0,
  allWorkersAtCapacity: 0,
  deadLettered: 0,
  delayed: 0,
  unadoptedTerminal: 0,
};

/** Scripts every standing successful route the route root needs, with overridable fixtures. */
function routeHappyPaths(
  scripted: ScriptedFetch,
  overrides: {
    workers?: readonly WorkerSummary[];
    deployments?: readonly WorkerDeploymentSummary[];
    queues?: readonly TaskQueueHealth[];
    diagnosticsItems?: readonly TaskDiagnosticItem[];
    diagnosticsSummary?: TaskDiagnosticsSummary;
  } = {},
): void {
  scripted.routeJsonRpcMethod('weft.workers.list', {
    items: overrides.workers ?? [worker()],
    deployments: overrides.deployments ?? [deployment()],
    routingPolicy: 'least-loaded',
  });
  scripted.routeJsonRpcMethod('weft.task.queues.list', {
    items: overrides.queues ?? [queue()],
  });
  scripted.routeJsonRpcMethod('weft.tasks.diagnostics', {
    items: overrides.diagnosticsItems ?? [],
    summary: overrides.diagnosticsSummary ?? EMPTY_DIAGNOSTICS_SUMMARY,
  });
  scripted.routeJsonRpcMethod('weft.workers.diagnostics', { worker: null });
  scripted.routeJsonRpcMethod('weft.workers.rejections', { items: [], limit: 25 });
}

let scripted: ScriptedFetch | undefined;

function happyDomAPI(): DetachedWindowAPI {
  return (window as unknown as { happyDOM: DetachedWindowAPI }).happyDOM;
}

/** Same convention `system/index.test.ts` (Track E2) and `router.svelte.test.ts` (T1.3) establish: give the window a real origin before the reactive `router` singleton is touched. */
function resetLocation(path = '/workers'): void {
  happyDomAPI().setURL('http://localhost/');
  router.navigate(path, { replace: true });
}

beforeEach(() => {
  resetLocation();
});

afterEach(() => {
  scripted?.restore();
  scripted = undefined;
});

async function renderWorkersRoute(
  principalScopes: readonly ('system:read' | 'system:admin' | 'events:read')[] = [
    'system:read',
    'system:admin',
  ],
) {
  return render(WorkersRouteTestHarness, {
    props: {
      client: realClient(),
      queryClient: createQueryClient(),
      component: WorkersRoute,
      principalScopes,
    },
  });
}

describe('Workers route — locked', () => {
  test('without system:read, the whole surface renders the locked EmptyState and no tabs', async () => {
    scripted = new ScriptedFetch();
    routeHappyPaths(scripted);

    const { findByText, queryByRole } = await renderWorkersRoute([]);

    expect(await findByText('Workers are locked')).not.toBeNull();
    expect(queryByRole('tab', { name: 'Fleet overview' })).toBeNull();
  });
});

describe('Workers route — Fleet overview tab', () => {
  test('renders FleetView with the fetched workers and deployments', async () => {
    scripted = new ScriptedFetch();
    routeHappyPaths(scripted, {
      workers: [worker({ id: 'wkr_fleet' })],
      deployments: [deployment({ deploymentName: 'api-prod' })],
    });

    const { findByText } = await renderWorkersRoute();

    expect(await findByText('api-prod')).not.toBeNull();
  });

  test('draining a deployment from the Fleet tab opens the drain dialog, and confirming calls weft.worker.deployments.drain', async () => {
    scripted = new ScriptedFetch();
    routeHappyPaths(scripted, {
      workers: [worker()],
      deployments: [deployment({ deploymentName: 'api-prod' })],
    });
    scripted.routeJsonRpcMethod('weft.worker.deployments.drain', { ok: true });

    const { findAllByRole, findByRole } = await renderWorkersRoute();

    const drainButtons = await findAllByRole('button', { name: 'Drain' });
    await fireEvent.click(drainButtons[0]!);

    const confirmButton = await findByRole('button', { name: 'Drain deployment' });
    await fireEvent.click(confirmButton);

    await new Promise((resolve) => setTimeout(resolve, 0));
    const drainCall = scripted.calls.find((call) => {
      try {
        return (
          typeof call.init?.body === 'string' &&
          (JSON.parse(call.init.body) as { method?: string }).method ===
            'weft.worker.deployments.drain'
        );
      } catch {
        return false;
      }
    });
    expect(drainCall).toBeDefined();
    const drainedDeployment = drainCall
      ? (JSON.parse(drainCall.init!.body as string) as { params: { deploymentName: string } })
          .params.deploymentName
      : undefined;
    expect(drainedDeployment).toBe('api-prod');
  });

  test('resuming a deployment from the Fleet tab calls weft.worker.deployments.resume directly, no dialog', async () => {
    scripted = new ScriptedFetch();
    routeHappyPaths(scripted, {
      workers: [worker()],
      deployments: [deployment({ deploymentName: 'api-prod', health: 'draining' })],
    });
    scripted.routeJsonRpcMethod('weft.worker.deployments.resume', { ok: true });

    const { findByRole, queryByRole } = await renderWorkersRoute();

    await fireEvent.click(await findByRole('button', { name: 'Resume' }));

    await new Promise((resolve) => setTimeout(resolve, 0));
    const resumeCall = scripted.calls.find((call) => {
      try {
        return (
          typeof call.init?.body === 'string' &&
          (JSON.parse(call.init.body) as { method?: string }).method ===
            'weft.worker.deployments.resume'
        );
      } catch {
        return false;
      }
    });
    expect(resumeCall).toBeDefined();
    // No drain-style dialog should have appeared for a resume action.
    expect(queryByRole('dialog', { name: 'Drain deployment' })).toBeNull();
  });
});

describe('Workers route — Workers tab, worker selection and drain/resume', () => {
  test('no worker selected renders WorkerListView', async () => {
    scripted = new ScriptedFetch();
    routeHappyPaths(scripted, { workers: [worker({ id: 'wkr_listed' })] });

    const { findByRole, findByText } = await renderWorkersRoute();

    await fireEvent.click(await findByRole('tab', { name: 'Workers' }));
    expect(await findByText('wkr_listed', { exact: false })).not.toBeNull();
  });

  test('selecting a worker via ?worker= renders WorkerDetailView, and draining it with a reason calls weft.workers.drain', async () => {
    scripted = new ScriptedFetch();
    routeHappyPaths(scripted, { workers: [worker({ id: 'wkr_selected', health: 'active' })] });
    scripted.routeJsonRpcMethod('weft.workers.drain', { ok: true });

    resetLocation('/workers?tab=list&worker=wkr_selected');
    const { findByLabelText, findByRole } = await renderWorkersRoute();

    await fireEvent.click(await findByRole('button', { name: 'Drain' }));
    const reasonInput = await findByLabelText('Reason');
    await fireEvent.input(reasonInput, { target: { value: 'rolling restart' } });
    await fireEvent.click(await findByRole('button', { name: 'Drain worker' }));

    await new Promise((resolve) => setTimeout(resolve, 0));
    const drainCall = scripted.calls.find((call) => {
      try {
        return (
          typeof call.init?.body === 'string' &&
          (JSON.parse(call.init.body) as { method?: string }).method === 'weft.workers.drain'
        );
      } catch {
        return false;
      }
    });
    expect(drainCall).toBeDefined();
    const params = JSON.parse(drainCall!.init!.body as string) as {
      params: { workerId: string; reason?: string };
    };
    expect(params.params.workerId).toBe('wkr_selected');
    expect(params.params.reason).toBe('rolling restart');
  });

  test('resuming a draining selected worker calls weft.workers.resume directly, no dialog', async () => {
    scripted = new ScriptedFetch();
    routeHappyPaths(scripted, { workers: [worker({ id: 'wkr_draining', health: 'draining' })] });
    scripted.routeJsonRpcMethod('weft.workers.resume', { ok: true });

    resetLocation('/workers?tab=list&worker=wkr_draining');
    const { findByRole } = await renderWorkersRoute();

    await fireEvent.click(await findByRole('button', { name: 'Resume' }));

    await new Promise((resolve) => setTimeout(resolve, 0));
    const resumeCall = scripted.calls.find((call) => {
      try {
        return (
          typeof call.init?.body === 'string' &&
          (JSON.parse(call.init.body) as { method?: string }).method === 'weft.workers.resume'
        );
      } catch {
        return false;
      }
    });
    expect(resumeCall).toBeDefined();
  });
});

describe('Workers route — Task queues tab, queue selection and dead-letter clear', () => {
  test('no queue selected renders QueueListView', async () => {
    scripted = new ScriptedFetch();
    routeHappyPaths(scripted, { queues: [queue({ queue: 'payments' })] });

    const { findByRole, findByText } = await renderWorkersRoute();

    await fireEvent.click(await findByRole('tab', { name: 'Task queues' }));
    expect(await findByText('payments')).not.toBeNull();
  });

  test("selecting a queue via ?queue= renders QueueDetailView filtered to that queue's workers and dead-lettered items", async () => {
    scripted = new ScriptedFetch();
    routeHappyPaths(scripted, {
      workers: [
        worker({ id: 'wkr_on_queue', queue: 'payments' }),
        worker({ id: 'wkr_other_queue', queue: 'billing' }),
      ],
      queues: [queue({ queue: 'payments' })],
      diagnosticsItems: [
        diagnosticItem({ queue: 'payments', operationId: 'op_on_queue' }),
        diagnosticItem({ queue: 'billing', operationId: 'op_other_queue' }),
      ],
      diagnosticsSummary: { ...EMPTY_DIAGNOSTICS_SUMMARY, deadLettered: 2 },
    });
    scripted.routeJsonRpcMethod('weft.tasks.get', {
      ...taskLedgerDetailFixture(),
      operationId: 'op_on_queue',
    });

    resetLocation('/workers?tab=queues&queue=payments');
    const { findAllByRole, findByText, queryByText } = await renderWorkersRoute();

    expect(await findByText('wkr_on_queue', { exact: false })).not.toBeNull();
    expect(queryByText('wkr_other_queue', { exact: false })).toBeNull();
    expect(await findByText('op_on_queue', { exact: false })).not.toBeNull();
    expect(queryByText('op_other_queue', { exact: false })).toBeNull();

    const inspectButtons = await findAllByRole('button', { name: 'Inspect ledger' });
    await fireEvent.click(inspectButtons[0]!);
    expect(await findByText('Authoritative task ledger')).not.toBeNull();
  });

  test('clearing a dead-lettered item on the selected queue opens the type-to-confirm dialog and calls the DELETE endpoint on confirm', async () => {
    scripted = new ScriptedFetch();
    routeHappyPaths(scripted, {
      queues: [queue({ queue: 'payments' })],
      diagnosticsItems: [diagnosticItem({ queue: 'payments', operationId: 'op_target' })],
      diagnosticsSummary: { ...EMPTY_DIAGNOSTICS_SUMMARY, deadLettered: 1 },
    });
    let deleteCalled = false;
    scripted.routeRest(
      (url, method) =>
        method === 'DELETE' && url.pathname === '/api/v1/tasks/diagnostics/dead-letter/op_target',
      () => {
        deleteCalled = true;
        return new Response(null, { status: 204 });
      },
    );

    resetLocation('/workers?tab=queues&queue=payments');
    const { findByLabelText, findByRole } = await renderWorkersRoute();

    await fireEvent.click(await findByRole('button', { name: 'Clear' }));
    const confirmInput = await findByLabelText(/Type "op_target" to confirm/i);
    await fireEvent.input(confirmInput, { target: { value: 'op_target' } });
    await fireEvent.click(await findByRole('button', { name: 'Clear dead letter' }));

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(deleteCalled).toBe(true);
  });
});

describe('Workers route — Diagnostics tab', () => {
  test('renders DiagnosticsView with the fetched items and summary', async () => {
    scripted = new ScriptedFetch();
    routeHappyPaths(scripted, {
      diagnosticsItems: [diagnosticItem({ kind: 'retry-storm', queue: 'payments' })],
      diagnosticsSummary: { ...EMPTY_DIAGNOSTICS_SUMMARY, retryStorms: 1 },
    });
    scripted.routeJsonRpcMethod('weft.tasks.get', {
      ...taskLedgerDetailFixture(),
      operationId: 'op_dead_1',
    });

    const { findByRole, findByText } = await renderWorkersRoute();

    await fireEvent.click(await findByRole('tab', { name: 'Diagnostics' }));
    expect(await findByText('Retry storm')).not.toBeNull();
    await fireEvent.click(await findByRole('button', { name: 'Inspect ledger' }));
    expect(await findByText('Authoritative task ledger')).not.toBeNull();
  });

  test('a zeroed summary renders the "No diagnostics" empty state', async () => {
    scripted = new ScriptedFetch();
    routeHappyPaths(scripted);

    const { findByRole, findByText } = await renderWorkersRoute();

    await fireEvent.click(await findByRole('tab', { name: 'Diagnostics' }));
    expect(await findByText('No diagnostics')).not.toBeNull();
  });
});

describe('Workers route — loading skeletons', () => {
  test('the Fleet overview tab shows a loading skeleton before the workers query resolves', () => {
    scripted = new ScriptedFetch();
    routeHappyPaths(scripted);

    const { getByLabelText } = render(WorkersRouteTestHarness, {
      props: {
        client: realClient(),
        queryClient: createQueryClient(),
        component: WorkersRoute,
        principalScopes: ['system:read', 'system:admin'],
      },
    });

    // Synchronous assertion, before any awaited microtask lets the
    // scripted fetch's response settle — this is the one moment
    // `fleetLoading` is true.
    expect(getByLabelText('Loading fleet')).not.toBeNull();
  });

  test('the Task queues tab shows a loading skeleton before the queues query resolves', async () => {
    scripted = new ScriptedFetch();
    routeHappyPaths(scripted);
    // Registered after routeHappyPaths, so it wins for `weft.task.queues.list`
    // (ScriptedFetch matches the LAST registered route) and stays pending
    // through the awaits below — a synchronously-resolved route risks
    // TanStack Query processing the response during `findByRole`/
    // `fireEvent.click`'s awaited microtasks, flipping `queuesLoading` to
    // false before this assertion runs (flagged in WFC-10 PR #14 review).
    const queuesGate = scripted.deferJsonRpcMethod('weft.task.queues.list');

    const { findByRole, getByLabelText } = render(WorkersRouteTestHarness, {
      props: {
        client: realClient(),
        queryClient: createQueryClient(),
        component: WorkersRoute,
        principalScopes: ['system:read', 'system:admin'],
      },
    });

    await fireEvent.click(await findByRole('tab', { name: 'Task queues' }));
    expect(getByLabelText('Loading task queues')).not.toBeNull();
    queuesGate.resolve({ items: [queue()] });
  });

  test('the Diagnostics tab shows a loading skeleton before the diagnostics query resolves', async () => {
    scripted = new ScriptedFetch();
    routeHappyPaths(scripted);
    // Same deferred-response reasoning as the Task queues test above.
    const diagnosticsGate = scripted.deferJsonRpcMethod('weft.tasks.diagnostics');

    const { findByRole, getByLabelText } = render(WorkersRouteTestHarness, {
      props: {
        client: realClient(),
        queryClient: createQueryClient(),
        component: WorkersRoute,
        principalScopes: ['system:read', 'system:admin'],
      },
    });

    await fireEvent.click(await findByRole('tab', { name: 'Diagnostics' }));
    expect(getByLabelText('Loading diagnostics')).not.toBeNull();
    diagnosticsGate.resolve({ items: [], summary: EMPTY_DIAGNOSTICS_SUMMARY });
  });
});
