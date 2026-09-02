/**
 * Shared test-only workflow scenario registrations used by the replay-fixtures
 * and checkpoint-compat suites. The two suites both freeze observable engine
 * behavior against the same set of named workflows; this module is the single
 * source of truth for those registrations so both suites stay in lockstep.
 *
 * This module is consumed via deep import and intentionally not re-exported
 * from `src/testing/index.ts` — it is test infrastructure, not part of the
 * package surface. The `.test-support.ts` suffix is excluded by
 * `tsconfig.build.json` so this file never ships in `dist/`.
 */

import { Engine } from '../core/engine.ts';
import { compileStepWorkflow } from '../core/step-context.ts';
import {
  workflow,
  type ActivityDefinition,
  type StepWorkflowContext,
  type WorkflowContext,
} from '../core/types.ts';

/** Registers one or more workflow handlers for a named scenario on the engine. */
export type ScenarioHandlerRegistrar = (engine: Engine) => void;

async function pipeStageOne(_ctx: StepWorkflowContext, input: unknown): Promise<string> {
  return `s1:${String(input)}`;
}

async function pipeStageTwo(_ctx: StepWorkflowContext, input: unknown): Promise<string> {
  return `s2:${String(input)}`;
}

async function pipeStageThree(_ctx: StepWorkflowContext, input: unknown): Promise<string> {
  return `s3:${String(input)}`;
}

function registerSimpleSequential(engine: Engine): void {
  engine.register(
    workflow({ name: 'simple-sequential', version: '1' }).execute(async function* (
      ctx: WorkflowContext,
      input: unknown,
    ) {
      const result = yield* ctx.run(async (value: unknown) => `processed:${String(value)}`, input);
      return result;
    }),
  );
}

function registerTwoParallel(engine: Engine): void {
  engine.register(
    workflow({ name: 'two-parallel', version: '1' }).execute(async function* (
      ctx: WorkflowContext,
      input: unknown,
    ) {
      const context = ctx;
      const [left, right] = yield* context.all([
        context.run(async (value: unknown) => `left:${String(value)}`, input),
        context.run(async (value: unknown) => `right:${String(value)}`, input),
      ]);

      return { a: left, b: right };
    }),
  );
}

function registerRaceTakesFirst(engine: Engine): void {
  engine.register(
    workflow({ name: 'race-takes-first', version: '1' }).execute(async function* (
      ctx: WorkflowContext,
    ) {
      const context = ctx;
      const result = yield* context.race([
        context.run(async () => 'fast'),
        context.run(async () => {
          await Bun.sleep(50);
          return 'slow';
        }),
      ]);

      return result;
    }),
  );
}

function registerSignalAndWait(engine: Engine): void {
  engine.register(
    workflow({ name: 'signal-and-wait', version: '1' }).execute(async function* (
      ctx: WorkflowContext,
    ) {
      const payload = yield* ctx.waitForSignal('go');
      return { received: payload };
    }),
  );
}

function registerSleepAndResume(engine: Engine): void {
  engine.register(
    workflow({ name: 'sleep-and-resume', version: '1' }).execute(async function* (
      ctx: WorkflowContext,
    ) {
      yield* ctx.sleep(100);
      return 'awake';
    }),
  );
}

function registerChildWorkflow(engine: Engine): void {
  engine.register(
    workflow({ name: 'child-workflow-child', version: '1' }).execute(
      compileStepWorkflow(async function childWorkflowChild(
        _ctx: StepWorkflowContext,
        input: unknown,
      ) {
        return `child-result:${String(input)}`;
      }),
    ),
  );

  engine.register(
    workflow({ name: 'child-workflow', version: '1' }).execute(async function* (
      ctx: WorkflowContext,
      input: unknown,
    ) {
      const childResult = yield* ctx.startChild('child-workflow-child', input);
      return { parent: String(input), child: childResult };
    }),
  );
}

function registerSagaWithCompensation(engine: Engine): void {
  const compensated: string[] = [];

  engine.register(
    workflow({ name: 'saga-with-compensation', version: '1' }).execute(async function* (
      ctx: WorkflowContext,
    ) {
      const stepOne: ActivityDefinition<unknown, string> = {
        name: 'step-one',
        execute: async () => 'output-one',
        compensate: async (_input: unknown, output: string) => {
          compensated.push(output);
        },
      };
      const stepTwo: ActivityDefinition<unknown, string> = {
        name: 'step-two',
        execute: async () => {
          throw new Error('step-two-failed');
        },
      };

      try {
        yield* ctx.saga([
          { definition: stepOne, input: 'a' },
          { definition: stepTwo, input: 'b' },
        ]);
        return 'no-error';
      } catch {
        return `compensated:${compensated.join(',')}`;
      }
    }),
  );
}

function registerPipeThreeStages(engine: Engine): void {
  engine.register(
    workflow({ name: 'pipe-three-stages', version: '1' }).execute(async function* (
      ctx: WorkflowContext,
      input: unknown,
    ) {
      // Pass string names to `ctx.pipe(...)`. Passing bare step functions
      // required the engine to look the function up in `workflowTypesByHandler`
      // — that mapping only fires for raw `WorkflowFunction` references, but
      // the builder API stores the compiled generator as the registered
      // handler, so the original step function is no longer the registered
      // identity.
      return yield* ctx.pipe(['stage1', 'stage2', 'stage3'], input);
    }),
  );
  engine.register(
    workflow({ name: 'stage1', version: '1' }).execute(compileStepWorkflow(pipeStageOne)),
  );
  engine.register(
    workflow({ name: 'stage2', version: '1' }).execute(compileStepWorkflow(pipeStageTwo)),
  );
  engine.register(
    workflow({ name: 'stage3', version: '1' }).execute(compileStepWorkflow(pipeStageThree)),
  );
}

function registerForkFromCheckpoint(engine: Engine): void {
  engine.register(
    workflow({ name: 'fork-from-checkpoint', version: '1' }).execute(async function* (
      ctx: WorkflowContext,
    ) {
      const context = ctx;
      const phaseOne = yield* context.run(async () => 'phase-one');
      const branch = yield* context.waitForSignal('branch');
      return `${String(phaseOne)}:${String(branch)}`;
    }),
  );
}

function registerRecoveryAfterCrash(engine: Engine): void {
  engine.register(
    workflow({ name: 'recovery-after-crash', version: '1' }).execute(async function* (
      ctx: WorkflowContext,
    ) {
      const context = ctx;
      const stepOne = yield* context.run(async () => 'checkpoint-me');
      const stepTwo = yield* context.run(async () => `resumed:${String(stepOne)}`);
      return stepTwo;
    }),
  );
}

/** Dispatcher record mapping top-level scenario keys to their registrar. */
export const scenarioRegistrars: Record<string, ScenarioHandlerRegistrar> = {
  'simple-sequential': registerSimpleSequential,
  'two-parallel': registerTwoParallel,
  'race-takes-first': registerRaceTakesFirst,
  'signal-and-wait': registerSignalAndWait,
  'sleep-and-resume': registerSleepAndResume,
  'child-workflow': registerChildWorkflow,
  'saga-with-compensation': registerSagaWithCompensation,
  'pipe-three-stages': registerPipeThreeStages,
  'fork-from-checkpoint': registerForkFromCheckpoint,
  'recovery-after-crash': registerRecoveryAfterCrash,
};

/**
 * Sorted, frozen list of top-level scenario keys. Derived directly from
 * {@link scenarioRegistrars} — never hand-maintain a parallel list. Internal
 * engine workflow names registered as side effects (`child-workflow-child`,
 * `stage1`, `stage2`, `stage3`) are intentionally not part of this list.
 */
export const scenarioNames: readonly string[] = Object.freeze(
  Object.keys(scenarioRegistrars).toSorted(),
);

/** Looks up and invokes the registrar for `scenario`. Throws if unknown. */
export function registerScenarioHandlers(engine: Engine, scenario: string): void {
  const registrar = scenarioRegistrars[scenario];

  if (registrar === undefined) {
    throw new Error(`No scenario handler registered for "${scenario}"`);
  }

  registrar(engine);
}
