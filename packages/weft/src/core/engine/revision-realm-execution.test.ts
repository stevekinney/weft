/**
 * Engine-level proof for `workflowExecutionMode: 'realm'` (COR-249's engine
 * integration, R2E) — every test here drives a REAL `Engine`, REAL
 * `registerSource()`/`workflows.activate()` catalog machinery, and REAL Bun
 * `Worker`-backed revision realms end to end. Registry-level and
 * primitive-level proofs already exist in `src/core/realm/*.test.ts`
 * (R1/R2/R3); this file proves the same guarantees are reachable through
 * ordinary `engine.start()`/`engine.signal()`/recovery calls once an Engine
 * opts in.
 *
 * The host-side placeholder definitions registered below via
 * `registerSource()` are never invoked — `RevisionRealmExecutionStrategy`
 * never calls `RegistrationEntry.handler`; only `sentinel-workflow.fixture.ts`
 * and `order-workflow-handler.fixture.ts` (imported solely by the realm's
 * own worker bootstrap fixtures) hold real generator logic. This is what
 * "the realm, not the host, must load the workflow implementation module"
 * means in code, and the module-boundary test below proves it dynamically.
 */
import { describe, expect, it, mock, spyOn } from 'bun:test';

import { MemoryStorage } from '../../storage/memory.ts';
import { throwingRejectionOf } from '../../testing/promise-outcome.test-support.ts';
import { ActivityRegistry } from '../activity-registry.ts';
import type { RevisionRealmConfig } from '../realm/revision-realm-registry.ts';
import { buildWorkflowManifestFromDefinition } from '../registry-workflow-manifest.ts';
import { workflowSource } from '../source/index.ts';
import { workflow, type WorkflowDefinition } from '../types.ts';
import { copyWorkflowDefinition } from './construction.ts';
import {
  ENGINE_SIGNAL_WAITER_COUNT_FOR_TESTING,
  ENGINE_WAIT_FOR_SIGNAL_WAITER_FOR_TESTING,
  Engine,
  getRevisionRealmDiagnostics,
} from './index.ts';
import { getInternals } from './internals.ts';
import { buildRegistrationEntry } from './registration.ts';

/**
 * Wait for `workflowId` to park on its signal, then assert exactly
 * `expectedTotal` signal waiters are registered engine-wide — the same
 * engine-level bookkeeping `worker-execution-suspension.test.ts` uses to
 * prove a workflow genuinely parked on a `signal-wait` operation request, not
 * merely "probably fast enough." Populated when the engine processes a
 * `checkpoint` outbound message naming a `signal-wait` operation, regardless
 * of which `ExecutionStrategy` produced it.
 *
 * The park is awaited as an event rather than polled against a budget:
 * reaching it means booting a real revision-realm Worker, importing its
 * fixture and running a turn — work whose duration tracks host load, not
 * correctness (COR-1333). A workflow that never parks is a real hang,
 * reported by the test runner's own per-test timeout. The seam resolves per
 * workflow, so the engine-wide total is asserted separately.
 */
async function waitForSignalWaiter(
  engine: Engine,
  workflowId: string,
  expectedTotal: number,
): Promise<void> {
  await engine[ENGINE_WAIT_FOR_SIGNAL_WAITER_FOR_TESTING](workflowId);
  expect(engine[ENGINE_SIGNAL_WAITER_COUNT_FOR_TESTING]()).toBe(expectedTotal);
}

const ORDER_WORKFLOW_NAME = 'r2e-order-workflow';
const ORDER_RELEASE_SIGNAL = 'release';
const SENTINEL_WORKFLOW_NAME = 'r2e-sentinel-workflow';
const SENTINEL_FLAG = '__weftR2ESentinelWorkflowImported__';

const revisionAWorkerUrl = new URL(
  '../realm/__fixtures__/revision-a-order-worker.fixture.ts',
  import.meta.url,
);
const revisionBWorkerUrl = new URL(
  '../realm/__fixtures__/revision-b-order-worker.fixture.ts',
  import.meta.url,
);
const sentinelWorkerUrl = new URL(
  '../realm/__fixtures__/sentinel-worker.fixture.ts',
  import.meta.url,
);

/** A host-side placeholder never invoked by realm execution — its `handler` throws if that ever changes. Only its name/version/contract identity matters to the lifecycle machinery `registerSource()` feeds. */
function placeholderDefinition(name: string, description: string): WorkflowDefinition {
  return workflow({ name, description }).execute(async function* () {
    throw new Error(
      `${name}: this placeholder handler must never run — RevisionRealmExecutionStrategy routes execution to the realm, not the host.`,
    );
  });
}

/**
 * Derive the exact `revision` string `registerSource()` expects for a
 * definition — mirrors `dynamic-source-execution.test.ts`'s own helper.
 * Every placeholder definition here is a bare `workflow({name}).execute(fn)`
 * with no `.activities({...})` map, so the per-workflow activity registry is
 * always empty regardless of `isBuilderWorkflowDefinition`.
 */
async function revisionFor(definition: WorkflowDefinition): Promise<string> {
  const entry = buildRegistrationEntry(definition.name, definition);
  const registered = copyWorkflowDefinition(definition.name, entry);
  const manifest = await buildWorkflowManifestFromDefinition(
    registered,
    new ActivityRegistry().listDefinitions(),
  );
  return manifest.revision;
}

function newRealmEngine(configByRevision: Map<string, RevisionRealmConfig>): {
  engine: Engine;
  storage: MemoryStorage;
} {
  const storage = new MemoryStorage();
  const engine = new Engine({
    storage,
    backgroundTasks: 'manual',
    workflowExecutionMode: 'realm',
    revisionRealmExecution: {
      resolveRevisionRealmConfig: (_workflowType, revision) => configByRevision.get(revision),
    },
  });
  return { engine, storage };
}

/**
 * Register `revision` as a `registerSource()` candidate on `engine` and
 * resolve+install it, without activating it. A process resuming recovery
 * after a restart must re-register every revision its still-pinned runs
 * might need — not only the currently active one — exactly like `'worker'`
 * mode's own dynamic-source recovery already requires
 * (`dynamic-source-recovery.test.ts`).
 */
async function registerOnly(
  engine: Engine,
  name: string,
  revision: string,
  description: string,
): Promise<void> {
  const definition = placeholderDefinition(name, description);
  const loader = mock(async () => ({ [name]: definition }));
  engine.registerSource(
    workflowSource({ name, location: `./${name}.ts`, exportName: name, revision }, loader),
  );
  // Loads (the PLACEHOLDER definition only — never the realm's sentinel or
  // order-workflow implementation modules) and durably installs the
  // candidate, a precondition `workflows.activate()` enforces.
  await engine.resolveWorkflowSource(name, revision);
}

/** {@link registerOnly}, then activate `revision` (tolerating a prior active pointer, mirroring `dynamic-source-execution.test.ts`'s helper). */
async function registerAndActivate(
  engine: Engine,
  name: string,
  revision: string,
  description: string,
): Promise<void> {
  await registerOnly(engine, name, revision, description);
  const active = await engine.workflows.getActive(name);
  const result = await engine.workflows.activate(name, revision, {
    ...(active !== null && { expectedGeneration: active.generation }),
    policy: { requireExactRevision: false },
  });
  if (!result.applied) {
    throw new Error(`activate(${name}, ${revision}) was not applied: ${JSON.stringify(result)}`);
  }
}

describe('RevisionRealmExecutionStrategy (engine integration, COR-249)', () => {
  it('never imports the workflow implementation module on the host; the realm does (P-COR-29 criterion 1)', async () => {
    expect((globalThis as Record<string, unknown>)[SENTINEL_FLAG]).toBeUndefined();

    const revision = await revisionFor(placeholderDefinition(SENTINEL_WORKFLOW_NAME, 'sentinel'));
    const configByRevision = new Map<string, RevisionRealmConfig>([
      [
        revision,
        {
          workerUrl: sentinelWorkerUrl,
          expectedWorkflowTypes: [SENTINEL_WORKFLOW_NAME],
        },
      ],
    ]);
    const { engine } = newRealmEngine(configByRevision);
    try {
      await registerAndActivate(engine, SENTINEL_WORKFLOW_NAME, revision, 'sentinel');
      const handle = await engine.start(SENTINEL_WORKFLOW_NAME, 'hello');
      const result = await handle.result();
      expect(result).toEqual({ sawInput: 'hello', ranInsideRealm: true });
    } finally {
      await engine[Symbol.asyncDispose]();
    }

    // The realm's own Worker thread has an isolated global object — its
    // import of the sentinel module can never touch the HOST's globalThis.
    // Staying undefined here, after a real result only that module's code
    // could have produced, proves the host's own thread never imported it.
    expect((globalThis as Record<string, unknown>)[SENTINEL_FLAG]).toBeUndefined();
  });

  it('runs two revisions of one workflow concurrently in distinct realms, and activation routes new starts to the new revision (P-COR-29 criteria 3-4)', async () => {
    const revisionA = await revisionFor(placeholderDefinition(ORDER_WORKFLOW_NAME, 'revision-a'));
    const revisionB = await revisionFor(placeholderDefinition(ORDER_WORKFLOW_NAME, 'revision-b'));
    expect(revisionA).not.toBe(revisionB);

    const configByRevision = new Map<string, RevisionRealmConfig>([
      [
        revisionA,
        {
          workerUrl: revisionAWorkerUrl,
          expectedWorkflowTypes: [ORDER_WORKFLOW_NAME],
          expectedArtifactDigest: 'r2e-digest-a',
          workerName: 'r2e-digest-a',
        },
      ],
      [
        revisionB,
        {
          workerUrl: revisionBWorkerUrl,
          expectedWorkflowTypes: [ORDER_WORKFLOW_NAME],
          expectedArtifactDigest: 'r2e-digest-b',
          workerName: 'r2e-digest-b',
        },
      ],
    ]);
    const { engine } = newRealmEngine(configByRevision);
    try {
      await registerAndActivate(engine, ORDER_WORKFLOW_NAME, revisionA, 'revision-a');

      const handleA = await engine.start(ORDER_WORKFLOW_NAME, 'input-a', { id: 'r2e-order-a' });
      await waitForSignalWaiter(engine, 'r2e-order-a', 1);

      // Activation while A is still mid-execution: A drains (no new starts),
      // but A's own in-flight realm is untouched — "the old realm remains
      // available for runs pinned to it."
      await registerAndActivate(engine, ORDER_WORKFLOW_NAME, revisionB, 'revision-b');

      const handleB = await engine.start(ORDER_WORKFLOW_NAME, 'input-b', { id: 'r2e-order-b' });
      await waitForSignalWaiter(engine, 'r2e-order-b', 2);

      // Both genuinely mid-execution at once, in distinct realms, before
      // either is released — proves concurrency, not just eventual success.
      const registry = getInternals(engine).revisionRealmRegistry;
      expect(registry?.activeRealmCount(ORDER_WORKFLOW_NAME, revisionA)).toBe(1);
      expect(registry?.activeRealmCount(ORDER_WORKFLOW_NAME, revisionB)).toBe(1);

      await engine.signal('r2e-order-a', ORDER_RELEASE_SIGNAL, 'go-a');
      await engine.signal('r2e-order-b', ORDER_RELEASE_SIGNAL, 'go-b');

      const resultA = await handleA.result();
      const resultB = await handleB.result();
      // Workflow A (started before activation) completed in revision A's
      // realm; workflow B (started after activation) was routed to the new
      // active revision B's realm — never the reverse.
      expect(resultA).toMatchObject({ revision: 'revision-a', input: 'input-a' });
      expect(resultB).toMatchObject({ revision: 'revision-b', input: 'input-b' });
    } finally {
      await engine[Symbol.asyncDispose]();
    }
  });

  it('weft.realms.diagnostics reports realms mid-execution (COR-243)', async () => {
    const revision = await revisionFor(placeholderDefinition(ORDER_WORKFLOW_NAME, 'diagnostics'));
    const configByRevision = new Map<string, RevisionRealmConfig>([
      [
        revision,
        {
          workerUrl: revisionAWorkerUrl,
          expectedWorkflowTypes: [ORDER_WORKFLOW_NAME],
          expectedArtifactDigest: 'r2e-diagnostics-digest',
          workerName: 'r2e-diagnostics-digest',
        },
      ],
    ]);
    const { engine } = newRealmEngine(configByRevision);
    try {
      expect(getRevisionRealmDiagnostics(engine)).toEqual([]);

      await registerAndActivate(engine, ORDER_WORKFLOW_NAME, revision, 'diagnostics');
      const handle = await engine.start(ORDER_WORKFLOW_NAME, 'input', {
        id: 'r2e-diagnostics-order',
      });
      await waitForSignalWaiter(engine, 'r2e-diagnostics-order', 1);

      const pools = getRevisionRealmDiagnostics(engine);
      expect(pools).toHaveLength(1);
      expect(pools[0]?.name).toBe(ORDER_WORKFLOW_NAME);
      expect(pools[0]?.revision).toBe(revision);
      expect(pools[0]?.revisionActive).toBe(true);
      expect(pools[0]?.realms).toHaveLength(1);
      expect(pools[0]?.realms[0]).toMatchObject({
        state: 'active',
        restartCount: 0,
        pendingTurnCount: 0,
      });
      expect(pools[0]?.realms[0]?.realmGeneration).not.toBeNull();

      await engine.signal('r2e-diagnostics-order', ORDER_RELEASE_SIGNAL, 'go');
      await handle.result();

      // The realm drained and terminated (never reused across two
      // executions — see `RevisionRealmPool`'s own module doc), but the
      // pool itself is NOT reclaimed: `revision` is still the catalog's
      // active pointer, so `RevisionRealmPool.isDrained` stays false (see
      // its own doc — only `markInactive` plus zero active realms reclaims
      // a pool). The diagnostics entry persists with an empty `realms` list.
      expect(getRevisionRealmDiagnostics(engine)).toEqual([
        { name: ORDER_WORKFLOW_NAME, revision, revisionActive: true, realms: [] },
      ]);
    } finally {
      await engine[Symbol.asyncDispose]();
    }
  });

  it('terminates a drained realm exactly once after its pinned work finishes, and the reclaimed revision refuses a further start (P-COR-29 criteria 5-6)', async () => {
    const revisionA = await revisionFor(placeholderDefinition(ORDER_WORKFLOW_NAME, 'drain-a'));
    const revisionB = await revisionFor(placeholderDefinition(ORDER_WORKFLOW_NAME, 'drain-b'));
    const configByRevision = new Map<string, RevisionRealmConfig>([
      [revisionA, { workerUrl: revisionAWorkerUrl, expectedWorkflowTypes: [ORDER_WORKFLOW_NAME] }],
      [revisionB, { workerUrl: revisionBWorkerUrl, expectedWorkflowTypes: [ORDER_WORKFLOW_NAME] }],
    ]);
    const { engine } = newRealmEngine(configByRevision);
    const terminateSpy = spyOn(Worker.prototype, 'terminate');
    try {
      await registerAndActivate(engine, ORDER_WORKFLOW_NAME, revisionA, 'drain-a');
      const handle = await engine.start(ORDER_WORKFLOW_NAME, 'input', { id: 'r2e-drain-a' });
      await waitForSignalWaiter(engine, 'r2e-drain-a', 1);

      // Deactivate revision A — no realm work is pinned to it any more once
      // this run finishes, so its pool must be fully reclaimed.
      await registerAndActivate(engine, ORDER_WORKFLOW_NAME, revisionB, 'drain-b');

      const callsBeforeRelease = terminateSpy.mock.calls.length;
      await engine.signal('r2e-drain-a', ORDER_RELEASE_SIGNAL, 'go');
      await handle.result();

      // Exactly one real Worker.terminate() call for the drained realm — not
      // zero (leaked) and not more than one (double-terminated).
      expect(terminateSpy.mock.calls.length).toBe(callsBeforeRelease + 1);

      const registry = getInternals(engine).revisionRealmRegistry;
      expect(registry?.getPool(ORDER_WORKFLOW_NAME, revisionA)).toBeUndefined();

      // A late/new execution for the drained, inactive revision cannot
      // acquire a realm at all — "cannot deliver an accepted late result"
      // holds structurally: there is no realm left to deliver one from.
      const lateOutcome = await registry?.acquireForExecution(
        ORDER_WORKFLOW_NAME,
        revisionA,
        'late-execution-token',
      );
      expect(lateOutcome).toEqual({ ok: false, reason: 'revision-not-active' });
    } finally {
      terminateSpy.mockRestore();
      await engine[Symbol.asyncDispose]();
    }
  });

  it('disposes the engine and terminates every realm exactly once (P-COR-29 criterion 8, COR-113 disposal path)', async () => {
    const revisionA = await revisionFor(placeholderDefinition(ORDER_WORKFLOW_NAME, 'dispose-a'));
    const configByRevision = new Map<string, RevisionRealmConfig>([
      [revisionA, { workerUrl: revisionAWorkerUrl, expectedWorkflowTypes: [ORDER_WORKFLOW_NAME] }],
    ]);
    const { engine } = newRealmEngine(configByRevision);
    const terminateSpy = spyOn(Worker.prototype, 'terminate');
    try {
      await registerAndActivate(engine, ORDER_WORKFLOW_NAME, revisionA, 'dispose-a');
      await engine.start(ORDER_WORKFLOW_NAME, 'input', { id: 'r2e-dispose-a' });
      await waitForSignalWaiter(engine, 'r2e-dispose-a', 1);

      const callsBeforeDispose = terminateSpy.mock.calls.length;
      // Concurrent async disposal must share one memoized teardown
      // (COR-113/WorkerExecutionDisposal) rather than terminating twice.
      await Promise.all([engine[Symbol.asyncDispose](), engine[Symbol.asyncDispose]()]);
      expect(terminateSpy.mock.calls.length).toBe(callsBeforeDispose + 1);
    } finally {
      terminateSpy.mockRestore();
    }
  });

  it('resumes a pinned run in its own revision realm after an engine restart, even though a newer revision is now active (durable revision pin, ADR 0005)', async () => {
    const revisionA = await revisionFor(placeholderDefinition(ORDER_WORKFLOW_NAME, 'recover-a'));
    const revisionB = await revisionFor(placeholderDefinition(ORDER_WORKFLOW_NAME, 'recover-b'));
    const configByRevision = new Map<string, RevisionRealmConfig>([
      [revisionA, { workerUrl: revisionAWorkerUrl, expectedWorkflowTypes: [ORDER_WORKFLOW_NAME] }],
      [revisionB, { workerUrl: revisionBWorkerUrl, expectedWorkflowTypes: [ORDER_WORKFLOW_NAME] }],
    ]);
    const { engine: engine1, storage } = newRealmEngine(configByRevision);
    await registerAndActivate(engine1, ORDER_WORKFLOW_NAME, revisionA, 'recover-a');
    await engine1.start(ORDER_WORKFLOW_NAME, 'input', { id: 'r2e-recover-a' });
    await waitForSignalWaiter(engine1, 'r2e-recover-a', 1);
    // Simulate a crash/restart: dispose without letting the run complete.
    // Its durable `WorkflowState.revision` pin (revisionA) survives in
    // `storage`; the catalog's active pointer is about to move past it.
    await engine1[Symbol.asyncDispose]();

    const engine2 = new Engine({
      storage,
      backgroundTasks: 'manual',
      workflowExecutionMode: 'realm',
      revisionRealmExecution: {
        resolveRevisionRealmConfig: (_type, revision) => configByRevision.get(revision),
      },
    });
    try {
      // Re-register revision A (still pinned by the recovering run) without
      // activating it, then activate revision B on the SECOND engine, same
      // durable catalog — new starts should go to B, but the recovered run
      // must stay pinned to A.
      await registerOnly(engine2, ORDER_WORKFLOW_NAME, revisionA, 'recover-a');
      await registerAndActivate(engine2, ORDER_WORKFLOW_NAME, revisionB, 'recover-b');
      await engine2.recoverAll();
      await waitForSignalWaiter(engine2, 'r2e-recover-a', 1);

      const state = await engine2.get('r2e-recover-a');
      // Attach to the recovered run's result before releasing it, so its
      // completion is observed as an event rather than polled from storage.
      const recoveredResult = engine2.getHandle('r2e-recover-a').result();
      await engine2.signal('r2e-recover-a', ORDER_RELEASE_SIGNAL, 'go');
      expect(await recoveredResult).toMatchObject({ revision: 'revision-a' });
      expect(state?.revision).toBe(revisionA);
    } finally {
      await engine2[Symbol.asyncDispose]();
    }
  });

  it('a resumeWorkflow() call that reaches this id right after cancelling it while PARKED leaves the workflow cancelled, not failed (correction round 3 regression, P-COR-29 criterion 7)', async () => {
    // `engine.cancel()` calls `strategy.cancelWorkflow()` synchronously as its
    // very first step (`termination/complete.ts`), then awaits two storage
    // reads of its own BEFORE it durably commits the `cancelled` status. A
    // CONCURRENTLY delivered `engine.signal()` for the same, PARKED workflow
    // needs its own several storage round-trips before its chain ever
    // reaches `strategy.resumeWorkflow()` — so a real concurrent cancel+
    // signal pair routinely delivers that `resumeWorkflow()` call for the
    // same, already-torn-down id WHILE cancel's own commit is still
    // in-flight, not after it lands. Before this round's fix (a prior
    // round's `#cancelled.add()` gated on `#inFlight.has()`, which never
    // records a cancel-while-PARKED at all), that racing call fell through
    // the strategy's "no revision realm assigned" branch and emitted an
    // outbound `failed` message whose own `failWorkflow` write — needing
    // only ONE storage read versus `terminateWorkflow`'s TWO — could reach
    // the per-workflow serialized write queue first and durably record the
    // workflow `failed` before cancel's own write lands, dropping its cancel
    // handlers and leaving `handle.result()` reject with a bogus "no
    // revision realm assigned" error instead of surfacing cancellation.
    //
    // Reproduced here WITHOUT any timing margin: `strategy.cancelWorkflow()`
    // and `strategy.resumeWorkflow()` are invoked back to back, synchronously,
    // through the REAL strategy the engine itself constructed and wired —
    // exactly `engine.cancel()`'s own first step, immediately followed by
    // the racing signal's `resumeWorkflow()` call, both BEFORE `engine.cancel()`
    // itself ever runs. This gives a would-be spurious failure the earliest
    // possible start against cancel's own (not yet started) storage reads —
    // deterministic under `MemoryStorage`'s synchronous, non-macrotask
    // resolution, not a probabilistic race.
    const revision = await revisionFor(placeholderDefinition(ORDER_WORKFLOW_NAME, 'cancel-race'));
    const configByRevision = new Map<string, RevisionRealmConfig>([
      [revision, { workerUrl: revisionAWorkerUrl, expectedWorkflowTypes: [ORDER_WORKFLOW_NAME] }],
    ]);
    const { engine } = newRealmEngine(configByRevision);
    try {
      await registerAndActivate(engine, ORDER_WORKFLOW_NAME, revision, 'cancel-race');
      const workflowId = 'r2e-cancel-race-a';
      const handle = await engine.start(ORDER_WORKFLOW_NAME, 'input', { id: workflowId });
      await waitForSignalWaiter(engine, workflowId, 1);

      const strategy = getInternals(engine).strategy;
      // Simulates `engine.cancel()`'s own synchronous first step, run
      // directly so the racing `resumeWorkflow()` call immediately below can
      // be injected before `engine.cancel()`'s own async work ever starts.
      strategy.cancelWorkflow(workflowId);
      // The racing, concurrently-delivered signal's `resumeWorkflow()` call
      // for the same, now-torn-down id — landing at the earliest possible
      // moment, immediately after `cancelWorkflow()`'s own `#executions`
      // deletion.
      strategy.resumeWorkflow({
        workflowId,
        checkpoint: new ArrayBuffer(0),
        operationResult: { status: 'completed', value: 'go' },
      });

      // NOW run the real cancellation to completion — its own
      // `strategy.cancelWorkflow()` call is a no-op this time (already torn
      // down above), so this exercises exactly `engine.cancel()`'s own
      // storage reads and terminal commit, racing whatever the injected
      // `resumeWorkflow()` call may have kicked off.
      await engine.cancel(workflowId);

      // The workflow's durable status must read `cancelled` — never
      // overwritten to `failed` by the racing call's spurious failure — and
      // its handle must reject with the real cancellation, not a bogus "no
      // revision realm assigned" error.
      const finalState = await engine.get(workflowId);
      expect(finalState?.status).toBe('cancelled');
      expect(await throwingRejectionOf(handle.result())).toThrow(/cancelled/i);
    } finally {
      await engine[Symbol.asyncDispose]();
    }
  });
});
