/**
 * Verifies JSON trace fixtures both deserialize and can be regenerated through
 * the workflow write path.
 *
 * Contract: These fixtures freeze observable behavior. Engine PRs must not
 * change any EXISTING record — key, value, or ordering — inside a fixture;
 * that is a regression. The one narrow exception: a PR that adds a new,
 * independent durable key namespace (e.g. WFT-9/WFT-10's `catalog-entry:`/
 * `catalog-active:` prefixes) may regenerate fixtures to add records under
 * that new namespace, PROVIDED the diff is purely additive — every existing
 * key's value and every existing key's presence is byte-for-byte unchanged.
 * Verify with a line-by-line diff against the prior fixture, not by
 * inspection of the regeneration script's intent; any change beyond new
 * keys is still a regression and must be reverted or justified as a real
 * semantic change instead.
 */

import { afterEach, describe, expect, it } from 'bun:test';

import { Engine } from '../../src/core/engine.ts';
import { MemoryStorage } from '../../src/storage/memory.ts';
import { waitForCondition } from '../../src/testing/fake-timers.test-support.ts';
import {
  registerScenarioHandlers,
  scenarioNames,
} from '../../src/testing/replay-scenarios.test-support.ts';
import { TestEngine } from '../../src/testing/test-engine.ts';
import {
  sortedStorageEntries,
  storageAsBase64Record,
  withDeterministicRuntime,
  type TraceFixture,
} from '../../src/testing/trace-fixture-support.test-support.ts';

type ScenarioRun = {
  engine: TestEngine;
  workflowId: string;
};

type ScenarioRunner = (fixture: TraceFixture) => Promise<ScenarioRun>;

const replayFixtureDirectory = 'tests/replay-fixtures';
const expectedFixtureCount = 10;
const glob = new Bun.Glob('*.json');
const fixtureFiles = [...glob.scanSync(replayFixtureDirectory)]
  .filter((file) => file !== 'replay-fixtures.test.ts' && !file.endsWith('.test.ts'))
  .toSorted();
const replayableScenarioFiles = [
  'child-workflow.json',
  'fork-from-checkpoint.json',
  'pipe-three-stages.json',
  'race-takes-first.json',
  'recovery-after-crash.json',
  'saga-with-compensation.json',
  'signal-and-wait.json',
  'simple-sequential.json',
  'sleep-and-resume.json',
  'two-parallel.json',
] as const;

async function loadFixture(file: string): Promise<TraceFixture> {
  const value = await Bun.file(`${replayFixtureDirectory}/${file}`).json();
  return value as TraceFixture;
}

async function storageFromFixture(fixture: TraceFixture): Promise<MemoryStorage> {
  const storage = new MemoryStorage();

  for (const [key, encodedValue] of Object.entries(fixture.storage).toSorted(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  )) {
    await storage.put(key, Uint8Array.from(Buffer.from(encodedValue, 'base64')));
  }

  return storage;
}

async function waitForCheckpoint(engine: Engine, workflowId: string): Promise<void> {
  await waitForCondition(
    async () => {
      const checkpoints = await engine.listCheckpoints(workflowId);
      return checkpoints.length > 0;
    },
    { timeoutMs: 500, intervalMs: 1, label: `checkpoint for ${workflowId}` },
  );
}

async function waitForCheckpointStep(
  engine: Engine,
  workflowId: string,
  step: number,
): Promise<void> {
  await waitForCondition(
    async () => {
      const checkpoints = await engine.listCheckpoints(workflowId);
      return checkpoints.some((checkpoint) => checkpoint.step === step);
    },
    { timeoutMs: 500, intervalMs: 1, label: `checkpoint step ${step} for ${workflowId}` },
  );
}

async function runFixtureWorkflow(fixture: TraceFixture): Promise<ScenarioRun> {
  const engine = new TestEngine({ startTime: 0 });
  registerScenarioHandlers(engine, fixture.scenario);

  const workflowId = fixture.finalState.id;
  const handle = await engine.start(fixture.scenario, fixture.finalState.input, { id: workflowId });
  await handle.result();

  return { engine, workflowId };
}

async function runSignalAndWaitFixture(fixture: TraceFixture): Promise<ScenarioRun> {
  const engine = new TestEngine({ startTime: 0 });
  registerScenarioHandlers(engine, 'signal-and-wait');

  const workflowId = fixture.finalState.id;
  const handle = await engine.start(fixture.scenario, fixture.finalState.input, { id: workflowId });
  await waitForCheckpoint(engine, workflowId);
  await engine.signal(workflowId, 'go', 'proceed');
  await handle.result();

  return { engine, workflowId };
}

async function runSleepAndResumeFixture(fixture: TraceFixture): Promise<ScenarioRun> {
  const engine = new TestEngine({ startTime: 0 });
  registerScenarioHandlers(engine, 'sleep-and-resume');

  const workflowId = fixture.finalState.id;
  const handle = await engine.start(fixture.scenario, fixture.finalState.input, { id: workflowId });
  await engine.advanceTime(100);
  await handle.result();

  return { engine, workflowId };
}

async function runRecoveryAfterCrashFixture(fixture: TraceFixture): Promise<ScenarioRun> {
  const engine = new TestEngine({ startTime: 0 });
  registerScenarioHandlers(engine, 'recovery-after-crash');

  const workflowId = fixture.finalState.id;
  await engine.start(fixture.scenario, fixture.finalState.input, { id: workflowId });
  await waitForCheckpoint(engine, workflowId);

  const recovered = engine.recover();
  engine[Symbol.dispose]();
  registerScenarioHandlers(recovered, 'recovery-after-crash');

  const recoveredHandles = await recovered.recoverAll();
  for (const recoveredHandle of recoveredHandles) {
    await recoveredHandle.result();
  }

  const recoveredState = await recovered.get(workflowId);
  if (recoveredState?.status !== 'completed') {
    await recovered.getHandle(workflowId).result();
  }

  return { engine: recovered, workflowId };
}

// The fork is taken at checkpoint step 2 (after the durable activity, while the
// workflow is suspended on the `branch` signal). Waiting only for the first
// checkpoint (step 1) would fork from the wrong point and diverge the forked
// id and storage bytes. The call sequence here mirrors the generator's
// runForkFromCheckpoint exactly so the deterministic UUID counter allocates the
// forked id `00000000-0000-4000-8000-000000000003`.
async function runForkFromCheckpointFixture(fixture: TraceFixture): Promise<ScenarioRun> {
  const engine = new TestEngine({ startTime: 0 });
  registerScenarioHandlers(engine, 'fork-from-checkpoint');

  const workflowId = fixture.finalState.id;
  const original = await engine.start(fixture.scenario, fixture.finalState.input, {
    id: workflowId,
  });
  await waitForCheckpointStep(engine, workflowId, 2);

  const forked = await engine.fork(workflowId);
  await engine.signal(workflowId, 'branch', 'left');
  await engine.signal(forked.id, 'branch', 'right');
  await original.result();
  await forked.result();

  return { engine, workflowId };
}

const scenarioRunners: Record<string, ScenarioRunner> = {
  'simple-sequential': runFixtureWorkflow,
  'two-parallel': runFixtureWorkflow,
  'race-takes-first': runFixtureWorkflow,
  'signal-and-wait': runSignalAndWaitFixture,
  'sleep-and-resume': runSleepAndResumeFixture,
  'child-workflow': runFixtureWorkflow,
  'saga-with-compensation': runFixtureWorkflow,
  'pipe-three-stages': runFixtureWorkflow,
  'fork-from-checkpoint': runForkFromCheckpointFixture,
  'recovery-after-crash': runRecoveryAfterCrashFixture,
};

// withDeterministicRuntime mutates global crypto.randomUUID and Date.now for the
// duration of the runner and restores them afterward, so overlapping invocations
// would corrupt each other's stand-ins and silently change fixture bytes. The
// it() blocks below are registered in for loops and bun:test runs them
// sequentially; never wrap these calls in Promise.all or any concurrent combinator.
async function runScenarioFromFixture(fixture: TraceFixture): Promise<ScenarioRun> {
  const runner = scenarioRunners[fixture.scenario];

  if (runner === undefined) {
    throw new Error(`No replay runner registered for "${fixture.scenario}"`);
  }

  return withDeterministicRuntime(() => runner(fixture));
}

async function expectReplayToMatchFixture(fixtureFile: string): Promise<void> {
  const fixture = await loadFixture(fixtureFile);
  const { engine, workflowId } = await runScenarioFromFixture(fixture);

  try {
    await expect(engine.get(workflowId)).resolves.toEqual(fixture.finalState);
    await expect(engine.getEvents(workflowId)).resolves.toEqual(fixture.events);
    await expect(engine.getTimeline(workflowId)).resolves.toEqual(fixture.timeline);
    expect(storageAsBase64Record(sortedStorageEntries(engine.storage))).toEqual(fixture.storage);

    if (fixture.replayMetadata !== undefined) {
      // A present `replayMetadata` must carry at least one additional terminal
      // state; an empty array would let this assertion block pass vacuously.
      expect(fixture.replayMetadata.additionalTerminalStates.length).toBeGreaterThan(0);
      for (const additionalState of fixture.replayMetadata.additionalTerminalStates) {
        await expect(engine.get(additionalState.id)).resolves.toEqual(additionalState);
      }
    }
  } finally {
    engine[Symbol.dispose]();
  }
}

describe('fixture inventory', () => {
  it('has the expected fixture count', () => {
    expect(fixtureFiles).toHaveLength(expectedFixtureCount);
  });

  it('keeps fixture scenarios and registered scenario handlers in sync', async () => {
    const onDisk = new Set<string>();
    for (const fixtureFile of fixtureFiles) {
      const fixture = await loadFixture(fixtureFile);
      onDisk.add(fixture.scenario);
    }
    const registered = new Set(scenarioNames);
    expect([...onDisk].toSorted()).toEqual([...registered].toSorted());
  });
});

describe('storage format compatibility', () => {
  let engine: Engine | undefined;

  afterEach(() => {
    engine?.[Symbol.dispose]();
    engine = undefined;
  });

  for (const fixtureFile of fixtureFiles) {
    it(`deserializes ${fixtureFile}`, async () => {
      const fixture = await loadFixture(fixtureFile);
      const storage = await storageFromFixture(fixture);
      engine = new Engine({ storage });
      const workflowId = fixture.finalState.id;

      await expect(engine.getEvents(workflowId)).resolves.toEqual(fixture.events);
      await expect(engine.getTimeline(workflowId)).resolves.toEqual(fixture.timeline);
      await expect(engine.get(workflowId)).resolves.toEqual(fixture.finalState);

      // Multi-terminal scenarios (for example, fork) persist additional
      // terminal workflows beyond finalState. Without this assertion the suite
      // would only validate the original workflow and silently miss a broken
      // forked terminal state.
      if (fixture.replayMetadata !== undefined) {
        expect(fixture.replayMetadata.additionalTerminalStates.length).toBeGreaterThan(0);
        for (const additionalState of fixture.replayMetadata.additionalTerminalStates) {
          await expect(engine.get(additionalState.id)).resolves.toEqual(additionalState);
        }
      }
    });
  }
});

describe('write-path replay', () => {
  for (const fixtureFile of replayableScenarioFiles) {
    it(`replays ${fixtureFile}`, async () => {
      await expectReplayToMatchFixture(fixtureFile);
    });
  }
});
