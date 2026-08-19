/**
 * Tests for the workflow constraint primitive.
 *
 * Constraints are domain invariants checked at every checkpoint commit.
 * On violation the engine dispatches a `ConstraintViolatedEvent` and reacts
 * per `onViolation`: 'fail' | 'compensate' | 'warn'.
 */

import { describe, expect, it, spyOn } from 'bun:test';

import type { ConstraintCheckState } from '../constraint.ts';
import { constraint } from '../constraint.ts';
import { Engine } from '../engine.ts';
import { ConstraintViolatedEvent } from '../events.ts';
import { workflow, type ActivityDefinition, type WorkflowContext } from '../types.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeActivity<TInput, TOutput>(options: {
  name: string;
  execute: (input: TInput) => TOutput | Promise<TOutput>;
  compensate?: (input: TInput, output: TOutput) => void | Promise<void>;
}): ActivityDefinition<TInput, TOutput> {
  return {
    name: options.name,
    execute: async (input: TInput) => options.execute(input),
    ...(options.compensate !== undefined ? { compensate: options.compensate } : {}),
  };
}

// ---------------------------------------------------------------------------
// 1. Violated constraint with onViolation: 'compensate' triggers saga
//    compensators.
// ---------------------------------------------------------------------------

describe('constraint primitive', () => {
  it('violated constraint with onViolation: compensate triggers saga compensators', async () => {
    const engine = new Engine();
    const compensationOrder: string[] = [];
    const violationEvents: ConstraintViolatedEvent[] = [];

    // Track violation events.
    engine.addEventListener('constraint:violated', (event) => {
      violationEvents.push(event);
    });

    // A flag flipped by step-one's execute. The constraint fails exactly once,
    // on the checkpoint commit that follows step-one's completion.
    let stepOneComplete = false;
    let constraintViolationAllowed = true; // Only fail once.

    const balanceCheck = constraint({
      name: 'positiveBalance',
      scope: 'transaction',
      check: () => {
        if (!constraintViolationAllowed) return true; // Only violate once.
        if (stepOneComplete) {
          constraintViolationAllowed = false;
          return false; // Trigger the violation.
        }
        return true;
      },
      onViolation: 'compensate',
    });

    const stepOne = makeActivity({
      name: 'step-one',
      execute: (_input: string) => {
        stepOneComplete = true;
        return 'output-one';
      },
      compensate: (_input, _output) => {
        compensationOrder.push('step-one');
      },
    });

    const stepTwo = makeActivity({
      name: 'step-two',
      execute: (_input: string) => 'output-two',
      compensate: (_input, _output) => {
        compensationOrder.push('step-two');
      },
    });

    const constrainedSagaWorkflow = workflow({
      name: 'constrained-saga',
      constraints: [balanceCheck],
    }).execute(async function* (ctx: WorkflowContext) {
      const c = ctx;
      yield* c.saga([
        { definition: stepOne, input: 'a' },
        { definition: stepTwo, input: 'b' },
      ]);
    });
    engine.register(constrainedSagaWorkflow);

    const handle = await engine.start('constrained-saga', null);
    await expect(handle.result()).rejects.toThrow('Constraint violated: positiveBalance');

    // The ConstraintViolatedEvent must have fired.
    expect(violationEvents).toHaveLength(1);
    expect(violationEvents[0]!.constraintName).toBe('positiveBalance');
    expect(violationEvents[0]!.scope).toBe('transaction');
    expect(violationEvents[0]!.onViolation).toBe('compensate');

    // step-one completed before the violation, so its compensator must run.
    // step-two never ran, so it has no compensator call.
    expect(compensationOrder).toEqual(['step-one']);

    engine[Symbol.dispose]();
  });

  // ---------------------------------------------------------------------------
  // 2. onViolation: 'fail' — workflow fails immediately.
  // ---------------------------------------------------------------------------

  it('violated constraint with onViolation: fail causes the workflow to fail immediately', async () => {
    const engine = new Engine();
    const violationEvents: ConstraintViolatedEvent[] = [];
    let compensatorCalled = false;

    engine.addEventListener('constraint:violated', (event) => {
      violationEvents.push(event);
    });

    let firstStepComplete = false;
    let constraintAllowed = true;

    const hardLimit = constraint({
      name: 'hardLimit',
      scope: 'budget',
      check: () => {
        if (!constraintAllowed) return true;
        if (firstStepComplete) {
          constraintAllowed = false;
          return false;
        }
        return true;
      },
      onViolation: 'fail',
    });

    const step = makeActivity({
      name: 'step',
      execute: (_input: string) => {
        firstStepComplete = true;
        return 'ok';
      },
      compensate: () => {
        compensatorCalled = true;
      },
    });

    const failFastWorkflow = workflow({ name: 'fail-fast', constraints: [hardLimit] }).execute(
      async function* (ctx: WorkflowContext) {
        const c = ctx;
        yield* c.saga([
          { definition: step, input: 'x' },
          { definition: step, input: 'y' },
        ]);
      },
    );
    engine.register(failFastWorkflow);

    const handle = await engine.start('fail-fast', null);
    await expect(handle.result()).rejects.toThrow('Constraint violated: hardLimit');

    // Event must have fired.
    expect(violationEvents).toHaveLength(1);
    expect(violationEvents[0]!.onViolation).toBe('fail');

    // With 'fail', the workflow fails directly — saga compensators do NOT run.
    // This is the key behavioral difference from 'compensate'.
    expect(compensatorCalled).toBe(false);

    engine[Symbol.dispose]();
  });

  // ---------------------------------------------------------------------------
  // 2b. Regression: 'fail' and 'compensate' MUST have different behavior.
  //     'fail' bypasses saga; 'compensate' throws into the generator.
  // ---------------------------------------------------------------------------

  it("'compensate' runs saga compensators but 'fail' does not — behaviors are distinct", async () => {
    async function runWithViolation(onViolation: 'fail' | 'compensate'): Promise<boolean> {
      const engine = new Engine();
      let compensatorRan = false;

      let stepDone = false;
      let allowedOnce = true;

      const c = constraint({
        name: 'test',
        scope: 'test',
        check: () => {
          if (stepDone && allowedOnce) {
            allowedOnce = false;
            return false;
          }
          return true;
        },
        onViolation,
      });

      const step = makeActivity({
        name: 'step',
        execute: (_input: string) => {
          stepDone = true;
          return 'ok';
        },
        compensate: () => {
          compensatorRan = true;
        },
      });

      const wfWorkflow = workflow({ name: 'wf', constraints: [c] }).execute(async function* (
        ctx: WorkflowContext,
      ) {
        const cx = ctx;
        yield* cx.saga([
          { definition: step, input: 'x' },
          { definition: step, input: 'y' },
        ]);
      });
      engine.register(wfWorkflow);

      const handle = await engine.start('wf', null);
      await handle.result().catch(() => {});
      engine[Symbol.dispose]();
      return compensatorRan;
    }

    // 'compensate' throws into generator — active saga catches it and runs compensators
    const compensateRanCompensators = await runWithViolation('compensate');
    expect(compensateRanCompensators).toBe(true);

    // 'fail' bypasses generator — saga never sees the error, no compensators run
    const failRanCompensators = await runWithViolation('fail');
    expect(failRanCompensators).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // 3. onViolation: 'warn' — workflow continues, event fires.
  // ---------------------------------------------------------------------------

  it('violated constraint with onViolation: warn fires event but workflow continues', async () => {
    const engine = new Engine();
    const violationEvents: ConstraintViolatedEvent[] = [];

    engine.addEventListener('constraint:violated', (event) => {
      violationEvents.push(event);
    });

    let checkpointCount = 0;

    const softLimit = constraint({
      name: 'softLimit',
      scope: 'advisory',
      check: () => {
        checkpointCount += 1;
        // Fail once (on second checkpoint), then pass again.
        return checkpointCount !== 2;
      },
      onViolation: 'warn',
    });

    const step = makeActivity({
      name: 'step',
      execute: (input: number) => input + 1,
    });

    const warnOnlyWorkflow = workflow({ name: 'warn-only', constraints: [softLimit] }).execute(
      async function* (ctx: WorkflowContext) {
        const c = ctx;
        return yield* c.saga([
          { definition: step, input: 1 },
          { definition: step, input: 2 },
        ]);
      },
    );
    engine.register(warnOnlyWorkflow);

    const handle = await engine.start('warn-only', null);
    const result = await handle.result();

    // Workflow completed successfully despite the violation.
    expect(result).toBe(3);

    // Event fired for the violation.
    expect(violationEvents.length).toBeGreaterThanOrEqual(1);
    expect(violationEvents[0]!.constraintName).toBe('softLimit');
    expect(violationEvents[0]!.onViolation).toBe('warn');

    engine[Symbol.dispose]();
  });

  it('treats a throwing constraint check as a warned violation', async () => {
    const warning = spyOn(console, 'warn').mockImplementation(() => {});
    const engine = new Engine();
    const throwingConstraint = constraint({
      name: 'throwing-check',
      scope: 'advisory',
      check: () => {
        throw new Error('constraint dependency unavailable');
      },
      onViolation: 'warn',
    });
    const step = makeActivity({ name: 'throwing-check-step', execute: () => 'done' });
    const constrainedWorkflow = workflow({
      name: 'throwing-check-workflow',
      constraints: [throwingConstraint],
    }).execute(async function* (ctx: WorkflowContext) {
      return yield* ctx.saga([{ definition: step, input: undefined }]);
    });
    engine.register(constrainedWorkflow);

    try {
      const handle = await engine.start('throwing-check-workflow', null);
      await expect(handle.result()).resolves.toBe('done');
      expect(warning).toHaveBeenCalledWith(
        '[weft] Constraint "throwing-check" check() threw an error:',
        expect.objectContaining({ message: 'constraint dependency unavailable' }),
      );
    } finally {
      warning.mockRestore();
      engine[Symbol.dispose]();
    }
  });

  // ---------------------------------------------------------------------------
  // 4. Constraint check runs at each checkpoint.
  // ---------------------------------------------------------------------------

  it('check function is called at each checkpoint commit', async () => {
    const engine = new Engine();
    const checkpointsSeen: number[] = [];

    let count = 0;

    const counter = constraint({
      name: 'checkpoint-counter',
      scope: 'test',
      check: () => {
        count += 1;
        checkpointsSeen.push(count);
        return true; // Never violate — just count.
      },
      onViolation: 'warn',
    });

    const step = makeActivity({
      name: 'noop',
      execute: (input: number) => input,
    });

    const countCheckpointsWorkflow = workflow({
      name: 'count-checkpoints',
      constraints: [counter],
    }).execute(async function* (ctx: WorkflowContext) {
      const c = ctx;
      yield* c.saga([
        { definition: step, input: 1 },
        { definition: step, input: 2 },
        { definition: step, input: 3 },
      ]);
    });
    engine.register(countCheckpointsWorkflow);

    const handle = await engine.start('count-checkpoints', null);
    await handle.result();

    // Each saga step creates a checkpoint, so the check should have been
    // called at least once per step.
    expect(checkpointsSeen.length).toBeGreaterThanOrEqual(3);

    engine[Symbol.dispose]();
  });

  // ---------------------------------------------------------------------------
  // 5. constraint() factory returns the correct shape.
  // ---------------------------------------------------------------------------

  it('constraint() factory produces the expected ConstraintDefinition', () => {
    const check = (_state: ConstraintCheckState) => true;
    const defined = constraint({
      name: 'myConstraint',
      scope: 'domain',
      check,
      onViolation: 'warn',
    });

    expect(defined.name).toBe('myConstraint');
    expect(defined.scope).toBe('domain');
    expect(defined.check).toBe(check);
    expect(defined.onViolation).toBe('warn');
  });

  // ---------------------------------------------------------------------------
  // 6. ConstraintViolatedEvent has the correct event type string.
  // ---------------------------------------------------------------------------

  it('ConstraintViolatedEvent fires with type "constraint:violated"', async () => {
    const engine = new Engine();
    const events: Event[] = [];

    engine.addEventListener('constraint:violated', (event) => {
      events.push(event);
    });

    let fired = false;

    const alwaysFail = constraint({
      name: 'alwaysFail',
      scope: 'test',
      check: () => {
        const first = !fired;
        fired = true;
        return first; // Fail on second checkpoint.
      },
      onViolation: 'warn',
    });

    const step = makeActivity({
      name: 'step',
      execute: (_input: string) => 'done',
    });

    const eventTypeCheckWorkflow = workflow({
      name: 'event-type-check',
      constraints: [alwaysFail],
    }).execute(async function* (ctx: WorkflowContext) {
      const c = ctx;
      yield* c.saga([
        { definition: step, input: 'a' },
        { definition: step, input: 'b' },
      ]);
    });
    engine.register(eventTypeCheckWorkflow);

    const handle = await engine.start('event-type-check', null);
    await handle.result();

    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events[0]!.type).toBe('constraint:violated');

    engine[Symbol.dispose]();
  });

  // -------------------------------------------------------------------------
  // Worker execution mode rejects constraint registration.
  //
  // Constraints are evaluated via the inline strategy's per-workflow context.
  // Worker mode has no inline strategy, so every constraint would be silently
  // skipped at runtime. The engine must fail loudly at registration time.
  // -------------------------------------------------------------------------

  it('throws when registering a workflow with constraints on a worker-mode engine', () => {
    const engine = new Engine({
      workflowExecutionMode: 'worker',
      workerExecution: {
        workerUrl: new URL('https://example.invalid/worker.js'),
        poolSize: 1,
      },
    });

    const alwaysOk = constraint({
      name: 'alwaysOk',
      scope: 'transaction',
      check: () => true,
      onViolation: 'warn',
    });

    expect(() => {
      const workerModeConstrainedWorkflow = workflow({
        name: 'worker-mode-constrained',
        constraints: [alwaysOk],
      }).execute(async function* (_ctx: WorkflowContext) {
        return 'done';
      });
      engine.register(workerModeConstrainedWorkflow);
    }).toThrow(/constraints are not supported in worker execution mode/);

    engine[Symbol.dispose]();
  });

  it('allows registering a workflow with constraints on the default (inline) engine', () => {
    const engine = new Engine();

    const alwaysOk = constraint({
      name: 'alwaysOk',
      scope: 'transaction',
      check: () => true,
      onViolation: 'warn',
    });

    expect(() => {
      const inlineModeConstrainedWorkflow = workflow({
        name: 'inline-mode-constrained',
        constraints: [alwaysOk],
      }).execute(async function* (_ctx: WorkflowContext) {
        return 'done';
      });
      engine.register(inlineModeConstrainedWorkflow);
    }).not.toThrow();

    engine[Symbol.dispose]();
  });
});
