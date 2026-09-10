import { describe, expect, it, mock } from 'bun:test';

import { KEYS } from '../../storage/interface.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { waitForCondition } from '../../testing/fake-timers.test-support.ts';
import { encode } from '../codec.ts';
import type { ChildWorkflowInterception } from '../interceptor/interception-contexts.ts';
import { StartWorkflowValidationError } from '../start-workflow-validation.ts';
import { workflow, type WorkflowContext, type WorkflowState } from '../types.ts';
import type { ChildWorkflowOptions } from '../types/workflow-function.ts';
import { createChildWorkflowOperationCallbacks } from './callback-creators-bundles.ts';
import { executeChildWorkflow } from './child-workflow.ts';
import { WorkflowAlreadyExistsError } from './errors.ts';
import { Engine } from './index.ts';
import { getInternals } from './internals.ts';

// The public defense: `onTerminalConflict` must stay absent from `ChildWorkflowOptions`.
// If a future edit adds it, this fails to compile and forces a deliberate decision rather
// than silently turning the top-level restart policy into a child-start option.
type OnTerminalConflictAbsentFromChildOptions =
  'onTerminalConflict' extends keyof ChildWorkflowOptions ? false : true;
const _onTerminalConflictAbsent: OnTerminalConflictAbsentFromChildOptions = true;
void _onTerminalConflictAbsent;

function createWorkflowState(
  workflowId: string,
  overrides: Partial<WorkflowState> = {},
): WorkflowState {
  return {
    createdAt: 1,
    executionStateOwnerId: 'parent-owner',
    id: workflowId,
    input: { value: 1 },
    startedAt: 1,
    status: 'running',
    type: 'child',
    updatedAt: 1,
    versionTuple: { workflowVersion: '1' },
    ...overrides,
  };
}

function createInternals() {
  return {
    pendingExecutionStateOwnerId: undefined,
    pendingNestingDepth: undefined,
    pendingParentHeaders: undefined,
    workflowHeaders: new Map([['parent', new Map([['traceparent', '00-parent']])]]),
    // `executeChildWorkflow` awaits the child through
    // `getGeneratorOwnedWorkflowResultPromise`, not `childHandle.result()`, so
    // the parent's waiter can be fenced on its claim generation (ADR 0002).
    // That reads `resultResolvers`; `seedChildResult` pre-seeds it so these
    // tests exercise child-workflow logic without a storage round trip.
    resultResolvers: new Map<string, { promise: Promise<unknown> }>(),
    disposed: false,
    // `EngineInternals.workflowClaimRegistry` is `WorkflowClaimRegistry | null`
    // and production always initializes it to `null`. Leaving it `undefined`
    // makes the ADR 0002 wake fence's `=== null` check miss.
    workflowClaimRegistry: null,
  };
}

/**
 * Pre-seed the already-settled result waiter `getWorkflowResultPromise` returns
 * for an existing entry, so these tests never reach the storage bootstrap.
 */
function seedChildResult(
  internals: { resultResolvers: Map<string, { promise: Promise<unknown> }> },
  workflowId: string,
  value: unknown,
): void {
  internals.resultResolvers.set(workflowId, { promise: Promise.resolve(value) });
}

describe('engine child workflow helpers', () => {
  it('rethrows id collisions when the existing child state is missing', async () => {
    const internals = createInternals();
    const collision = new WorkflowAlreadyExistsError('child-id');

    await expect(
      executeChildWorkflow(
        internals as never,
        'parent',
        {
          input: { value: 1 },
          operationId: 'child:1',
          options: { id: 'child-id' },
          type: 'child-workflow',
          workflowType: 'child',
        },
        0,
        {
          getComposedWorkflowInterceptor: () => null,
          getHandle: () => ({ result: async () => 'cached' }) as never,
          loadWorkflowState: async (workflowId) =>
            workflowId === 'parent' ? createWorkflowState('parent') : null,
          start: async () => {
            throw collision;
          },
        },
      ),
    ).rejects.toBe(collision);

    expect(internals.pendingNestingDepth).toBeUndefined();
    expect(internals.pendingParentHeaders).toBeUndefined();
    expect(internals.pendingExecutionStateOwnerId).toBeUndefined();
  });

  it('reuses an existing matching child workflow after an id collision', async () => {
    const internals = createInternals();
    seedChildResult(internals, 'child-id', 'cached-child-result');
    const childHandle = { id: 'child-id', result: mock(async () => 'cached-child-result') };

    await expect(
      executeChildWorkflow(
        internals as never,
        'parent',
        {
          input: { value: 1 },
          operationId: 'child:2',
          options: { id: 'child-id' },
          type: 'child-workflow',
          workflowType: 'child',
        },
        0,
        {
          getComposedWorkflowInterceptor: () => null,
          getHandle: () => childHandle as never,
          loadWorkflowState: async (workflowId) =>
            workflowId === 'parent'
              ? createWorkflowState('parent')
              : createWorkflowState('child-id'),
          start: async () => {
            throw new WorkflowAlreadyExistsError('child-id');
          },
        },
      ),
    ).resolves.toBe('cached-child-result');

    // Deliberately NOT `expect(childHandle.result).toHaveBeenCalled()`. The
    // parent now awaits the child through the generator-owned waiter so the
    // settle can be fenced on the parent's claim generation; going through the
    // handle's own `result()` would produce an unfenced observational waiter.
    expect(childHandle.result).not.toHaveBeenCalled();
  });

  it('rejects an existing child workflow whose stored state differs', async () => {
    const internals = createInternals();

    await expect(
      executeChildWorkflow(
        internals as never,
        'parent',
        {
          input: { value: 1 },
          operationId: 'child:3',
          options: { id: 'child-id' },
          type: 'child-workflow',
          workflowType: 'child',
        },
        0,
        {
          getComposedWorkflowInterceptor: () => null,
          getHandle: () => ({ result: async () => 'cached' }) as never,
          loadWorkflowState: async (workflowId) =>
            workflowId === 'parent'
              ? createWorkflowState('parent')
              : createWorkflowState('child-id', { input: { value: 2 } }),
          start: async () => {
            throw new WorkflowAlreadyExistsError('child-id');
          },
        },
      ),
    ).rejects.toThrow(
      'Child workflow id collision for "child-id" does not match the requested child workflow',
    );
  });

  it('rethrows non-id-collision child start failures', async () => {
    const internals = createInternals();
    const failure = new Error('start failed');

    await expect(
      executeChildWorkflow(
        internals as never,
        'parent',
        {
          input: { value: 1 },
          operationId: 'child:non-collision',
          options: { id: 'child-id' },
          type: 'child-workflow',
          workflowType: 'child',
        },
        0,
        {
          getComposedWorkflowInterceptor: () => null,
          getHandle: () => ({ result: async () => 'cached' }) as never,
          loadWorkflowState: async () => createWorkflowState('parent'),
          start: async () => {
            throw failure;
          },
        },
      ),
    ).rejects.toBe(failure);
  });

  it('wraps child workflow execution with the composed workflow interceptor', async () => {
    const internals = createInternals();
    seedChildResult(internals, 'child-id', 'child-result');

    await expect(
      executeChildWorkflow(
        internals as never,
        'parent',
        {
          input: { value: 1 },
          operationId: 'child:4',
          options: { id: 'child-id' },
          type: 'child-workflow',
          workflowType: 'child',
        },
        0,
        {
          getComposedWorkflowInterceptor: () =>
            ({
              childWorkflow: async (
                interception: ChildWorkflowInterception,
                next: (interception: ChildWorkflowInterception) => Promise<unknown>,
              ) => ({
                headers: [...interception.parentHeaders],
                result: await next(interception),
              }),
            }) as never,
          getHandle: () => ({ id: 'child-id', result: async () => 'child-result' }) as never,
          loadWorkflowState: async (workflowId) =>
            workflowId === 'parent' ? createWorkflowState('parent') : null,
          start: async () => ({ id: 'child-id', result: async () => 'child-result' }) as never,
        },
      ),
    ).resolves.toEqual({
      headers: [['traceparent', '00-parent']],
      result: 'child-result',
    });
  });

  it('rejects onTerminalConflict smuggled onto a child-start', async () => {
    const internals = createInternals();
    const start = mock(async () => ({ result: async () => 'never' }) as never);

    // The real threat is a structurally valid `ChildWorkflowOptions` carrying one extra
    // runtime property (an untyped JS caller or a widened cast), not an impossible value.
    // Model exactly that: a genuine ChildWorkflowOptions intersected with the smuggled key.
    const smuggledOptions = {
      id: 'child-id',
      onTerminalConflict: 'start-new',
    } satisfies ChildWorkflowOptions & { onTerminalConflict: 'start-new' };

    await expect(
      executeChildWorkflow(
        internals as never,
        'parent',
        {
          input: { value: 1 },
          operationId: 'child:terminal-conflict',
          options: smuggledOptions,
          type: 'child-workflow',
          workflowType: 'child',
        },
        0,
        {
          getComposedWorkflowInterceptor: () => null,
          getHandle: () => ({ result: async () => 'never' }) as never,
          loadWorkflowState: async (workflowId) =>
            workflowId === 'parent' ? createWorkflowState('parent') : null,
          start,
        },
      ),
    ).rejects.toThrow('ctx.startChild does not support options.onTerminalConflict');

    // The guard fires before the start is dispatched — no replacement run is created.
    expect(start).not.toHaveBeenCalled();
    // Pending child-execution context is still cleared on the rejection path.
    expect(internals.pendingNestingDepth).toBeUndefined();
    expect(internals.pendingParentHeaders).toBeUndefined();
    expect(internals.pendingExecutionStateOwnerId).toBeUndefined();
  });

  it('reattaches to an already-persisted legacy "." child on crash-reattach replay (WFT-95)', async () => {
    const internals = createInternals();
    seedChildResult(internals, '.', 'legacy-child-result');
    const childHandle = { id: '.', result: mock(async () => 'legacy-child-result') };
    // The exact failure `coerceStartWorkflowId` raises for a fresh `options.id`
    // of "." or "..": strict admission (WFT-95), which a pre-WFT-95 persisted
    // child may already carry.
    const admissionError = new StartWorkflowValidationError('options.id must not be "." or ".."');
    let startCallCount = 0;

    await expect(
      executeChildWorkflow(
        internals as never,
        'parent',
        {
          input: { value: 1 },
          operationId: 'child:legacy-dot',
          options: { id: '.' },
          type: 'child-workflow',
          workflowType: 'child',
        },
        0,
        {
          getComposedWorkflowInterceptor: () => null,
          getHandle: () => childHandle as never,
          loadWorkflowState: async (workflowId) =>
            workflowId === 'parent' ? createWorkflowState('parent') : createWorkflowState('.'),
          start: async (_type, _input, _options, skipAdmissionIdCheck) => {
            startCallCount += 1;
            if (startCallCount === 1) {
              // The first attempt is a genuinely strict admission check —
              // the internal bypass must not be set preemptively.
              expect(skipAdmissionIdCheck).toBeUndefined();
              throw admissionError;
            }
            // Only the confirmed-reattach retry may bypass strict admission.
            expect(skipAdmissionIdCheck).toBe(true);
            throw new WorkflowAlreadyExistsError('.');
          },
        },
      ),
    ).resolves.toBe('legacy-child-result');

    expect(startCallCount).toBe(2);
    // Deliberately NOT `expect(childHandle.result).toHaveBeenCalled()` — see
    // the "reuses an existing matching child workflow" test above for why.
    expect(childHandle.result).not.toHaveBeenCalled();
  });

  it('rejects a genuinely fresh child start using the reserved "." id (WFT-95)', async () => {
    const internals = createInternals();
    const admissionError = new StartWorkflowValidationError('options.id must not be "." or ".."');
    const start = mock(async () => {
      throw admissionError;
    });

    await expect(
      executeChildWorkflow(
        internals as never,
        'parent',
        {
          input: { value: 1 },
          operationId: 'child:fresh-dot',
          options: { id: '.' },
          type: 'child-workflow',
          workflowType: 'child',
        },
        0,
        {
          getComposedWorkflowInterceptor: () => null,
          getHandle: () => ({ result: async () => 'never' }) as never,
          // No persisted child under "." exists yet — this is a genuinely
          // fresh admission, not a crash-reattach replay.
          loadWorkflowState: async (workflowId) =>
            workflowId === 'parent' ? createWorkflowState('parent') : null,
          start,
        },
      ),
    ).rejects.toBe(admissionError);

    // Strict admission stands: no retry with the bypass was attempted.
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('rejects the reserved "." id when a persisted "." workflow exists but does not match this request (WFT-95)', async () => {
    const internals = createInternals();
    const admissionError = new StartWorkflowValidationError('options.id must not be "." or ".."');
    const start = mock(async () => {
      throw admissionError;
    });

    await expect(
      executeChildWorkflow(
        internals as never,
        'parent',
        {
          input: { value: 1 },
          operationId: 'child:mismatched-dot',
          options: { id: '.' },
          type: 'child-workflow',
          workflowType: 'child',
        },
        0,
        {
          getComposedWorkflowInterceptor: () => null,
          getHandle: () => ({ result: async () => 'never' }) as never,
          // A "." workflow exists, but for a different type/input — it is not
          // this parent's child, so it must not be hijacked as a reattach
          // target. The original strict-admission rejection stands.
          loadWorkflowState: async (workflowId) =>
            workflowId === 'parent'
              ? createWorkflowState('parent')
              : createWorkflowState('.', { type: 'unrelated-workflow' }),
          start,
        },
      ),
    ).rejects.toBe(admissionError);

    // No retry with the bypass was attempted — the mismatch was caught before
    // ever calling `start()` again.
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('rethrows a non-collision failure from the confirmed-reattach retry (WFT-95)', async () => {
    const internals = createInternals();
    const admissionError = new StartWorkflowValidationError('options.id must not be "." or ".."');
    const retryFailure = new Error('storage unavailable during reattach retry');
    let startCallCount = 0;

    await expect(
      executeChildWorkflow(
        internals as never,
        'parent',
        {
          input: { value: 1 },
          operationId: 'child:retry-failure',
          options: { id: '.' },
          type: 'child-workflow',
          workflowType: 'child',
        },
        0,
        {
          getComposedWorkflowInterceptor: () => null,
          getHandle: () => ({ result: async () => 'never' }) as never,
          loadWorkflowState: async (workflowId) =>
            workflowId === 'parent' ? createWorkflowState('parent') : createWorkflowState('.'),
          start: async () => {
            startCallCount += 1;
            if (startCallCount === 1) {
              throw admissionError;
            }
            // The confirmed-reattach retry hits something other than the
            // expected duplicate-id conflict — that failure must propagate,
            // not be swallowed as though it were a successful reattach.
            throw retryFailure;
          },
        },
      ),
    ).rejects.toBe(retryFailure);

    expect(startCallCount).toBe(2);
  });
});

describe('WFT-95: real engine child-workflow crash-reattach replay', () => {
  it('reattaches to an already-persisted legacy "." child through the real startWorkflow/resolveTerminalConflictForRestart path', async () => {
    const storage = new MemoryStorage();
    const childWorkflow = workflow({ name: 'wft-95-legacy-child' }).execute(async function* () {
      return 'legacy-child-result';
    });
    const parentWorkflow = workflow({ name: 'wft-95-legacy-parent' }).execute(async function* (
      ctx: WorkflowContext,
    ) {
      yield* ctx.waitForSignal('release');
      return 'parent-done';
    });
    const workflows = {
      'wft-95-legacy-parent': parentWorkflow,
      'wft-95-legacy-child': childWorkflow,
    };

    await using engine = await Engine.create({ storage, workflows });
    const parentHandle = await engine.start('wft-95-legacy-parent', null, {
      id: 'wft-95-legacy-parent-1',
    });
    await waitForCondition(
      async () => {
        const parentState = await engine.get(parentHandle.id);
        return parentState?.status === 'running';
      },
      { label: 'parent running' },
    );

    // Seed a completed child persisted under "." — the one id strict
    // admission (WFT-95) now rejects — standing in for a run created before
    // that rejection existed. `parentWorkflowId`/`parentWorkflowExecutionToken`
    // are left undefined to model the legacy pre-lineage shape
    // `existingChildMatchesRequest` still accepts (see its own doc comment).
    // `executionStateOwnerId` matches the parent's own id: `executeChildWorkflow`
    // falls back to `workflowId` when the parent's own state carries none.
    const legacyChildState: WorkflowState = {
      createdAt: 1,
      executionStateOwnerId: parentHandle.id,
      id: '.',
      input: null,
      result: 'legacy-child-result',
      startedAt: 1,
      status: 'completed',
      type: 'wft-95-legacy-child',
      updatedAt: 1,
      versionTuple: { workflowVersion: '1' },
    };
    await storage.put(KEYS.workflow('.'), encode(legacyChildState));

    // Drive `executeChildWorkflow` directly with the REAL callback bundle
    // (`createChildWorkflowOperationCallbacks`, the same wiring
    // `processChildWorkflowOperation` uses in production) instead of the
    // hand-mocked callbacks the tests above use — this proves the actual
    // `start.ts`/`start-workflow-validation.ts`/`resolveTerminalConflictForRestart`
    // chain reattaches through a real `WorkflowAlreadyExistsError`, not just
    // that the dispatch logic calls its callbacks in the right order.
    const result = await executeChildWorkflow(
      getInternals(engine),
      parentHandle.id,
      {
        input: null,
        operationId: 'child:legacy-dot-real',
        options: { id: '.' },
        type: 'child-workflow',
        workflowType: 'wft-95-legacy-child',
      },
      0,
      createChildWorkflowOperationCallbacks(engine),
    );

    // Reattached to the seeded completed child instead of failing recovery —
    // this is the generator-owned result the parent's `yield* ctx.startChild()`
    // would receive.
    expect(result).toBe('legacy-child-result');
    // No duplicate/replacement run was created under "." — the seeded record
    // is untouched.
    await expect(engine.get('.')).resolves.toMatchObject({
      status: 'completed',
      result: 'legacy-child-result',
    });

    await engine.signal(parentHandle.id, 'release');
  });
});

describe('WFT-79: cross-engine parent/child completion (ownership: "workflow-lease")', () => {
  it('a parent recovered on one engine still observes its child completing on a DIFFERENT engine', async () => {
    const storage = new MemoryStorage();
    const childWorkflow = workflow({ name: 'wft-79-child' }).execute(async function* (
      ctx: WorkflowContext,
    ) {
      yield* ctx.waitForSignal('go');
      return 'child-done';
    });
    const parentWorkflow = workflow({ name: 'wft-79-parent' }).execute(async function* (
      ctx: WorkflowContext,
    ) {
      return yield* ctx.startChild('wft-79-child', null, { id: 'wft-79-child-1' });
    });
    const workflows = { 'wft-79-parent': parentWorkflow, 'wft-79-child': childWorkflow };

    // Seed BOTH the parent (mid, uncheckpointed child-await turn) and the
    // child (durably parked on a signal) via a plain `ownership: 'none'`
    // engine — simulating a crashed prior owner that held no claim on
    // either. `ctx.startChild()`'s await is never checkpointed mid-flight
    // (there is no completed effect-log entry for an in-flight operation),
    // so the parent's LAST durable checkpoint predates the child even
    // existing — replay on any later owner reruns `ctx.startChild()` from
    // scratch.
    await using seedEngine = await Engine.create({ storage, workflows, recover: false });
    await seedEngine.start('wft-79-parent', null, { id: 'wft-79-parent-1' });
    await waitForCondition(
      async () => (await storage.get(KEYS.checkpoint('wft-79-child-1'))) !== null,
      { label: 'child checkpoint' },
    );

    const ownershipOptions = {
      ownership: 'workflow-lease' as const,
      workflowClaimTtl: 200,
      workflowClaimRenewInterval: 20,
      recover: false,
    };

    // Engine B claims and resumes the CHILD only — it never touches the parent.
    await using engineB = await Engine.create({ storage, workflows, ...ownershipOptions });
    await engineB.resume('wft-79-child-1');

    // Engine A claims and resumes the PARENT. Replay re-runs `ctx.startChild()`
    // from scratch: `dispatchChildWorkflowStart` hits the pre-existing child
    // id, `resolveTerminalConflictForRestart` throws `WorkflowAlreadyExistsError`
    // (child-start never permits `onTerminalConflict: 'start-new'`) BEFORE any
    // claim CAS is attempted, and `dispatchChildWorkflowStart`'s catch
    // re-attaches via `getHandle()` instead of restarting the child — proving
    // this replay path never surfaces `WorkflowClaimUnavailableError` even
    // though engine B already durably holds the child's claim.
    await using engineA = await Engine.create({ storage, workflows, ...ownershipOptions });
    const parentHandle = await engineA.resume('wft-79-parent-1');

    // Wait for A's replay to actually reach the child-await — i.e. for A to
    // register its OWN local waiter for the child — before completing the
    // child, so this test exercises the cross-engine POLL fallback
    // (`handle-result.ts`) rather than a lucky race against an
    // already-terminal read.
    const internalsA = getInternals(engineA);
    await waitForCondition(() => internalsA.resultResolvers.has('wft-79-child-1'), {
      label: "engine A's replay registering a local waiter for the child",
    });

    // Complete the child on its OWNING engine (B) only — A's `resultResolvers`
    // map is never touched by B's termination commit.
    await engineB.getHandle('wft-79-child-1').signal('go');
    await expect(engineB.getHandle('wft-79-child-1').result()).resolves.toBe('child-done');

    // The parent — owned by A, which never claimed the child — must still
    // observe completion instead of hanging forever.
    await expect(parentHandle.result()).resolves.toBe('child-done');
  });
});
