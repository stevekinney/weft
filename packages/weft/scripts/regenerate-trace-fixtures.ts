/**
 * Regenerates replay and checkpoint-compatibility fixtures for the durable
 * execution engine.
 *
 * Contract: These fixtures freeze observable behavior. Engine PRs must not
 * change them; if a fixture changes, that is a regression.
 */

import { Engine } from '../src/core/engine.ts';
import type { WorkflowState } from '../src/core/types.ts';
import {
  registerScenarioHandlers,
  scenarioNames,
} from '../src/testing/replay-scenarios.test-support.ts';
import { TestEngine } from '../src/testing/test-engine.ts';
import {
  sortedStorageEntries,
  storageAsBase64Record,
  withDeterministicRuntime,
  type TraceFixture,
} from '../src/testing/trace-fixture-support.test-support.ts';

type ScenarioRun = {
  engine: TestEngine;
  workflowId: string;
  /**
   * Terminal workflow ids produced beyond `workflowId` (for example, a forked
   * child). When present, each is captured into
   * `TraceFixture.replayMetadata.additionalTerminalStates`.
   */
  additionalTerminalWorkflowIds?: string[];
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

/**
 * Waits until a checkpoint at the given step exists. The fork scenario must
 * fork at step 2 (after the durable activity, while suspended on the `branch`
 * signal); waiting for any checkpoint (step 1) could fork from the wrong point
 * and produce persisted state and deterministic ids that disagree with the
 * write-path replay test, which waits for step 2. Both sides MUST agree.
 */
async function waitForCheckpointStep(
  engine: Engine,
  workflowId: string,
  step: number,
): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const checkpoints = await engine.listCheckpoints(workflowId);
    if (checkpoints.some((checkpoint) => checkpoint.step === step)) {
      return;
    }

    await Bun.sleep(10);
  }

  throw new Error(`Checkpoint step ${step} was not recorded for workflow "${workflowId}"`);
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
  registerScenarioHandlers(engine, 'simple-sequential');

  const handle = await engine.start('simple-sequential', 'hello', {
    id: 'wf-simple-sequential',
  });
  await handle.result();

  return { engine, workflowId: handle.id };
}

async function runTwoParallel(): Promise<ScenarioRun> {
  const engine = new TestEngine({ startTime: 0 });
  registerScenarioHandlers(engine, 'two-parallel');

  const handle = await engine.start('two-parallel', 'data', { id: 'wf-two-parallel' });
  await handle.result();

  return { engine, workflowId: handle.id };
}

async function runRaceTakesFirst(): Promise<ScenarioRun> {
  const engine = new TestEngine({ startTime: 0 });
  registerScenarioHandlers(engine, 'race-takes-first');

  const handle = await engine.start('race-takes-first', null, { id: 'wf-race-takes-first' });
  await handle.result();

  return { engine, workflowId: handle.id };
}

async function runSignalAndWait(): Promise<ScenarioRun> {
  const engine = new TestEngine({ startTime: 0 });
  registerScenarioHandlers(engine, 'signal-and-wait');

  const handle = await engine.start('signal-and-wait', null, { id: 'wf-signal-and-wait' });
  await waitForCheckpoint(engine, handle.id);
  await engine.signal('wf-signal-and-wait', 'go', 'proceed');
  await handle.result();

  return { engine, workflowId: handle.id };
}

async function runSleepAndResume(): Promise<ScenarioRun> {
  const engine = new TestEngine({ startTime: 0 });
  registerScenarioHandlers(engine, 'sleep-and-resume');

  const handle = await engine.start('sleep-and-resume', null, { id: 'wf-sleep-and-resume' });
  await engine.advanceTime(100);
  await handle.result();

  return { engine, workflowId: handle.id };
}

async function runChildWorkflow(): Promise<ScenarioRun> {
  const engine = new TestEngine({ startTime: 0 });
  registerScenarioHandlers(engine, 'child-workflow');

  const handle = await engine.start('child-workflow', 'parent-input', {
    id: 'wf-child-workflow',
  });
  await handle.result();

  return { engine, workflowId: handle.id };
}

async function runSagaWithCompensation(): Promise<ScenarioRun> {
  const engine = new TestEngine({ startTime: 0 });
  registerScenarioHandlers(engine, 'saga-with-compensation');

  const handle = await engine.start('saga-with-compensation', null, {
    id: 'wf-saga-with-compensation',
  });
  await handle.result();

  return { engine, workflowId: handle.id };
}

async function runPipeThreeStages(): Promise<ScenarioRun> {
  const engine = new TestEngine({ startTime: 0 });
  registerScenarioHandlers(engine, 'pipe-three-stages');

  const handle = await engine.start('pipe-three-stages', 'start', {
    id: 'wf-pipe-three-stages',
  });
  await handle.result();

  return { engine, workflowId: handle.id };
}

async function runForkFromCheckpoint(): Promise<ScenarioRun> {
  const engine = new TestEngine({ startTime: 0 });
  registerScenarioHandlers(engine, 'fork-from-checkpoint');

  const original = await engine.start('fork-from-checkpoint', null, { id: 'wf-fork-original' });
  await waitForCheckpointStep(engine, original.id, 2);

  const forked = await engine.fork('wf-fork-original');
  await engine.signal('wf-fork-original', 'branch', 'left');
  await engine.signal(forked.id, 'branch', 'right');
  await original.result();
  await forked.result();

  return { engine, workflowId: original.id, additionalTerminalWorkflowIds: [forked.id] };
}

async function runRecoveryAfterCrash(): Promise<ScenarioRun> {
  const engine = new TestEngine({ startTime: 0 });
  registerScenarioHandlers(engine, 'recovery-after-crash');

  const handle = await engine.start('recovery-after-crash', null, {
    id: 'wf-recovery-after-crash',
  });
  await waitForCheckpoint(engine, handle.id);

  const recovered = engine.recover();
  engine[Symbol.dispose]();
  registerScenarioHandlers(recovered, 'recovery-after-crash');

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

function assertScenarioInventory(): void {
  const generatorNames = scenarios.map(({ name }) => name).toSorted();
  if (JSON.stringify(generatorNames) !== JSON.stringify(scenarioNames)) {
    throw new Error(
      `Generator scenarios do not match canonical scenarioNames. Generator: ${generatorNames.join(', ')}; canonical: ${scenarioNames.join(', ')}`,
    );
  }
}

async function writeScenarioFixture(scenario: ScenarioDefinition): Promise<void> {
  const { engine, workflowId, additionalTerminalWorkflowIds } = await withDeterministicRuntime(
    scenario.run,
  );

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

    if (additionalTerminalWorkflowIds !== undefined) {
      const additionalTerminalStates: WorkflowState[] = [];
      for (const additionalId of additionalTerminalWorkflowIds) {
        const additionalState = await engine.get(additionalId);
        if (additionalState === null) {
          throw new Error(
            `Additional terminal workflow "${additionalId}" was not found after scenario "${scenario.name}"`,
          );
        }
        additionalTerminalStates.push(additionalState);
      }
      fixture.replayMetadata = { version: 1, additionalTerminalStates };
    }

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

  assertScenarioInventory();

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
