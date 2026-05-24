/**
 * Regenerates replay and checkpoint-compatibility fixtures for the durable
 * execution engine.
 *
 * Contract: These fixtures freeze observable behavior. Engine PRs must not
 * change them; if a fixture changes, that is a regression.
 */

import type { Context } from '../src/core/context.ts';
import { Engine } from '../src/core/engine.ts';
import { compileStepWorkflow } from '../src/core/step-context.ts';
import {
  workflow,
  type ActivityDefinition,
  type StepWorkflowContext,
  type WorkflowContext,
  type WorkflowEvent,
  type WorkflowState,
  type WorkflowTimelineEntry,
} from '../src/core/types.ts';
import { TestEngine } from '../src/testing/test-engine.ts';
import {
  sortedStorageEntries,
  storageAsBase64Record,
  withDeterministicRuntime,
} from '../src/testing/trace-fixture-support.test-support.ts';

type TraceFixture = {
  scenario: string;
  description: string;
  events: WorkflowEvent[];
  timeline: WorkflowTimelineEntry[];
  finalState: WorkflowState;
  storage: Record<string, string>;
};

type ScenarioRun = {
  engine: TestEngine;
  workflowId: string;
};

type ScenarioDefinition = {
  name: string;
  description: string;
  run: () => Promise<ScenarioRun>;
};

const replayFixtureDirectory = 'tests/replay-fixtures';
const checkpointFixtureDirectory = 'tests/checkpoint-compat';
const textEncoder = new TextEncoder();

function serializeSnapshot(entries: readonly (readonly [string, Uint8Array])[]): Uint8Array {
  const encodedEntries = entries.map(([key, value]) => ({
    keyBytes: textEncoder.encode(key),
    value,
  }));
  const byteLength =
    4 +
    encodedEntries.reduce(
      (total, entry) => total + 4 + entry.keyBytes.byteLength + 4 + entry.value.byteLength,
      0,
    );
  const bytes = new Uint8Array(byteLength);
  const view = new DataView(bytes.buffer);
  let offset = 0;

  view.setUint32(offset, encodedEntries.length, true);
  offset += 4;

  for (const entry of encodedEntries) {
    view.setUint32(offset, entry.keyBytes.byteLength, true);
    offset += 4;
    bytes.set(entry.keyBytes, offset);
    offset += entry.keyBytes.byteLength;
    view.setUint32(offset, entry.value.byteLength, true);
    offset += 4;
    bytes.set(entry.value, offset);
    offset += entry.value.byteLength;
  }

  return bytes;
}

async function waitForCheckpoint(engine: Engine, workflowId: string): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const checkpoints = await engine.listCheckpoints(workflowId);
    if (checkpoints.length > 0) {
      return;
    }

    await Bun.sleep(10);
  }

  throw new Error(`Checkpoint was not recorded for workflow "${workflowId}"`);
}

async function pipeStageOne(_ctx: StepWorkflowContext, input: unknown): Promise<string> {
  return `s1:${String(input)}`;
}

async function pipeStageTwo(_ctx: StepWorkflowContext, input: unknown): Promise<string> {
  return `s2:${String(input)}`;
}

async function pipeStageThree(_ctx: StepWorkflowContext, input: unknown): Promise<string> {
  return `s3:${String(input)}`;
}

async function ensureFixtureDirectories(): Promise<void> {
  await Bun.$`mkdir -p ${replayFixtureDirectory} ${checkpointFixtureDirectory}`.quiet();
}

async function findExistingFixtureFiles(): Promise<string[]> {
  const existingFiles: string[] = [];

  for (const scenario of scenarios) {
    const jsonPath = `${replayFixtureDirectory}/${scenario.name}.json`;
    const binaryPath = `${checkpointFixtureDirectory}/${scenario.name}.bin`;

    if (await Bun.file(jsonPath).exists()) {
      existingFiles.push(jsonPath);
    }

    if (await Bun.file(binaryPath).exists()) {
      existingFiles.push(binaryPath);
    }
  }

  return existingFiles;
}

async function runSimpleSequential(): Promise<ScenarioRun> {
  const engine = new TestEngine({ startTime: 0 });

  engine.register(
    workflow({ name: 'simple-sequential' }).execute(async function* (
      ctx: WorkflowContext,
      input: unknown,
    ) {
      const result = yield* (ctx as Context).run(
        async (value: unknown) => `processed:${String(value)}`,
        input,
      );
      return result;
    }),
  );

  const handle = await engine.start('simple-sequential', 'hello', {
    id: 'wf-simple-sequential',
  });
  await handle.result();

  return { engine, workflowId: handle.id };
}

async function runTwoParallel(): Promise<ScenarioRun> {
  const engine = new TestEngine({ startTime: 0 });

  engine.register(
    workflow({ name: 'two-parallel' }).execute(async function* (
      ctx: WorkflowContext,
      input: unknown,
    ) {
      const context = ctx as Context;
      const [left, right] = yield* context.all([
        context.run(async (value: unknown) => `left:${String(value)}`, input),
        context.run(async (value: unknown) => `right:${String(value)}`, input),
      ]);

      return { a: left, b: right };
    }),
  );

  const handle = await engine.start('two-parallel', 'data', { id: 'wf-two-parallel' });
  await handle.result();

  return { engine, workflowId: handle.id };
}

async function runRaceTakesFirst(): Promise<ScenarioRun> {
  const engine = new TestEngine({ startTime: 0 });

  engine.register(
    workflow({ name: 'race-takes-first' }).execute(async function* (ctx: WorkflowContext) {
      const context = ctx as Context;
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

  const handle = await engine.start('race-takes-first', null, { id: 'wf-race-takes-first' });
  await handle.result();

  return { engine, workflowId: handle.id };
}

async function runSignalAndWait(): Promise<ScenarioRun> {
  const engine = new TestEngine({ startTime: 0 });

  engine.register(
    workflow({ name: 'signal-and-wait' }).execute(async function* (ctx: WorkflowContext) {
      const payload = yield* (ctx as Context).waitForSignal('go');
      return { received: payload };
    }),
  );

  const handle = await engine.start('signal-and-wait', null, { id: 'wf-signal-and-wait' });
  await waitForCheckpoint(engine, handle.id);
  await engine.signal('wf-signal-and-wait', 'go', 'proceed');
  await handle.result();

  return { engine, workflowId: handle.id };
}

async function runSleepAndResume(): Promise<ScenarioRun> {
  const engine = new TestEngine({ startTime: 0 });

  engine.register(
    workflow({ name: 'sleep-and-resume' }).execute(async function* (ctx: WorkflowContext) {
      yield* (ctx as Context).sleep(100);
      return 'awake';
    }),
  );

  const handle = await engine.start('sleep-and-resume', null, { id: 'wf-sleep-and-resume' });
  await engine.advanceTime(100);
  await handle.result();

  return { engine, workflowId: handle.id };
}

async function runChildWorkflow(): Promise<ScenarioRun> {
  const engine = new TestEngine({ startTime: 0 });

  engine.register(
    workflow({ name: 'child-workflow-child' }).execute(
      compileStepWorkflow(async function childWorkflowChild(
        _ctx: StepWorkflowContext,
        input: unknown,
      ) {
        return `child-result:${String(input)}`;
      }),
    ),
  );

  engine.register(
    workflow({ name: 'child-workflow' }).execute(async function* (
      ctx: WorkflowContext,
      input: unknown,
    ) {
      const childResult = yield* (ctx as Context).startChild('child-workflow-child', input);
      return { parent: String(input), child: childResult };
    }),
  );

  const handle = await engine.start('child-workflow', 'parent-input', {
    id: 'wf-child-workflow',
  });
  await handle.result();

  return { engine, workflowId: handle.id };
}

async function runSagaWithCompensation(): Promise<ScenarioRun> {
  const engine = new TestEngine({ startTime: 0 });
  const compensated: string[] = [];

  engine.register(
    workflow({ name: 'saga-with-compensation' }).execute(async function* (ctx: WorkflowContext) {
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
        yield* (ctx as Context).saga([
          { definition: stepOne, input: 'a' },
          { definition: stepTwo, input: 'b' },
        ]);
        return 'no-error';
      } catch {
        return `compensated:${compensated.join(',')}`;
      }
    }),
  );

  const handle = await engine.start('saga-with-compensation', null, {
    id: 'wf-saga-with-compensation',
  });
  await handle.result();

  return { engine, workflowId: handle.id };
}

async function runPipeThreeStages(): Promise<ScenarioRun> {
  const engine = new TestEngine({ startTime: 0 });

  engine.register(
    workflow({ name: 'pipe-three-stages' }).execute(async function* (
      ctx: WorkflowContext,
      input: unknown,
    ) {
      return yield* ctx.pipe(['stage1', 'stage2', 'stage3'], input);
    }),
  );
  engine.register(workflow({ name: 'stage1' }).execute(compileStepWorkflow(pipeStageOne)));
  engine.register(workflow({ name: 'stage2' }).execute(compileStepWorkflow(pipeStageTwo)));
  engine.register(workflow({ name: 'stage3' }).execute(compileStepWorkflow(pipeStageThree)));

  const handle = await engine.start('pipe-three-stages', 'start', {
    id: 'wf-pipe-three-stages',
  });
  await handle.result();

  return { engine, workflowId: handle.id };
}

async function runForkFromCheckpoint(): Promise<ScenarioRun> {
  const engine = new TestEngine({ startTime: 0 });

  engine.register(
    workflow({ name: 'fork-from-checkpoint' }).execute(async function* (ctx: WorkflowContext) {
      const context = ctx as Context;
      const phaseOne = yield* context.run(async () => 'phase-one');
      const branch = yield* context.waitForSignal('branch');
      return `${String(phaseOne)}:${String(branch)}`;
    }),
  );

  const original = await engine.start('fork-from-checkpoint', null, { id: 'wf-fork-original' });
  await waitForCheckpoint(engine, original.id);

  const forked = await engine.fork('wf-fork-original');
  await engine.signal('wf-fork-original', 'branch', 'left');
  await engine.signal(forked.id, 'branch', 'right');
  await original.result();
  await forked.result();

  return { engine, workflowId: original.id };
}

async function runRecoveryAfterCrash(): Promise<ScenarioRun> {
  const engine = new TestEngine({ startTime: 0 });

  const registerRecoveryWorkflow = (target: Engine): void => {
    target.register(
      workflow({ name: 'recovery-after-crash' }).execute(async function* (ctx: WorkflowContext) {
        const context = ctx as Context;
        const stepOne = yield* context.run(async () => 'checkpoint-me');
        const stepTwo = yield* context.run(async () => `resumed:${String(stepOne)}`);
        return stepTwo;
      }),
    );
  };

  registerRecoveryWorkflow(engine);

  const handle = await engine.start('recovery-after-crash', null, {
    id: 'wf-recovery-after-crash',
  });
  await waitForCheckpoint(engine, handle.id);

  const recovered = engine.recover();
  engine[Symbol.dispose]();
  registerRecoveryWorkflow(recovered);

  const recoveredHandles = await recovered.recoverAll();
  for (const recoveredHandle of recoveredHandles) {
    await recoveredHandle.result();
  }

  const recoveredState = await recovered.get('wf-recovery-after-crash');
  if (recoveredState?.status !== 'completed') {
    const recoveredHandle = recovered.getHandle('wf-recovery-after-crash');
    await recoveredHandle.result();
  }

  return { engine: recovered, workflowId: 'wf-recovery-after-crash' };
}

const scenarios: ScenarioDefinition[] = [
  {
    name: 'simple-sequential',
    description: 'A workflow runs one durable activity and completes with its result.',
    run: runSimpleSequential,
  },
  {
    name: 'two-parallel',
    description: 'A workflow runs two durable activities in parallel and joins both results.',
    run: runTwoParallel,
  },
  {
    name: 'race-takes-first',
    description: 'A workflow races two durable activities and records the first result.',
    run: runRaceTakesFirst,
  },
  {
    name: 'signal-and-wait',
    description: 'A workflow waits for a signal and completes with the delivered payload.',
    run: runSignalAndWait,
  },
  {
    name: 'sleep-and-resume',
    description: 'A workflow persists a durable sleep and resumes after virtual time advances.',
    run: runSleepAndResume,
  },
  {
    name: 'child-workflow',
    description: 'A parent workflow starts a child workflow and returns both outputs.',
    run: runChildWorkflow,
  },
  {
    name: 'saga-with-compensation',
    description: 'A saga compensates a completed step after a later step fails.',
    run: runSagaWithCompensation,
  },
  {
    name: 'pipe-three-stages',
    description: 'A workflow pipes data through three registered child workflow stages.',
    run: runPipeThreeStages,
  },
  {
    name: 'fork-from-checkpoint',
    description: 'A running workflow is forked from its checkpoint and both branches complete.',
    run: runForkFromCheckpoint,
  },
  {
    name: 'recovery-after-crash',
    description: 'A copied storage snapshot is recovered and the workflow reaches completion.',
    run: runRecoveryAfterCrash,
  },
];

async function writeScenarioFixture(scenario: ScenarioDefinition): Promise<void> {
  const { engine, workflowId } = await withDeterministicRuntime(scenario.run);

  try {
    const finalState = await engine.get(workflowId);
    if (finalState === null) {
      throw new Error(`Workflow "${workflowId}" was not found after scenario "${scenario.name}"`);
    }

    const entries = sortedStorageEntries(engine.storage);
    const fixture: TraceFixture = {
      scenario: scenario.name,
      description: scenario.description,
      events: await engine.getEvents(workflowId),
      timeline: await engine.getTimeline(workflowId),
      finalState,
      storage: storageAsBase64Record(entries),
    };

    await Bun.write(
      `${replayFixtureDirectory}/${scenario.name}.json`,
      `${JSON.stringify(fixture, null, 2)}\n`,
    );
    await Bun.write(
      `${checkpointFixtureDirectory}/${scenario.name}.bin`,
      serializeSnapshot(entries),
    );
  } finally {
    engine[Symbol.dispose]();
  }
}

async function main(): Promise<void> {
  const confirmed = Bun.argv.includes('--confirm');

  const existingFixtureFiles = await findExistingFixtureFiles();

  if (!confirmed) {
    const existingMessage =
      existingFixtureFiles.length > 0
        ? ` Existing fixture files would be overwritten:\n${existingFixtureFiles.join('\n')}`
        : '';
    console.error(
      `Refusing to regenerate trace fixtures without --confirm.${existingMessage}\n` +
        'Run: bun run scripts/regenerate-trace-fixtures.ts --confirm',
    );
    process.exit(1);
  }

  await ensureFixtureDirectories();

  for (const scenario of scenarios) {
    await writeScenarioFixture(scenario);
    console.log(`wrote fixtures for ${scenario.name}`);
  }
}

await main();
