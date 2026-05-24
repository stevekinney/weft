/**
 * Verifies JSON trace fixtures both deserialize and can be regenerated through
 * the workflow write path.
 *
 * Contract: These fixtures freeze observable behavior. Engine PRs must not
 * change them; if a fixture changes, that is a regression.
 */

import { afterEach, describe, expect, it, test } from 'bun:test';

import { Engine } from '../../src/core/engine.ts';
import type { WorkflowEvent, WorkflowState, WorkflowTimelineEntry } from '../../src/core/types.ts';
import { MemoryStorage } from '../../src/storage/memory.ts';
import { waitForCondition } from '../../src/testing/fake-timers.ts';
import {
  registerScenarioHandlers,
  scenarioNames,
} from '../../src/testing/replay-scenarios.test-support.ts';
import { TestEngine } from '../../src/testing/test-engine.ts';
import {
  sortedStorageEntries,
  storageAsBase64Record,
  withDeterministicRuntime,
} from '../../src/testing/trace-fixture-support.test-support.ts';

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

type ScenarioRunner = (fixture: TraceFixture) => Promise<ScenarioRun>;

const replayFixtureDirectory = 'tests/replay-fixtures';
const expectedFixtureCount = 10;
const glob = new Bun.Glob('*.json');
const fixtureFiles = [...glob.scanSync(replayFixtureDirectory)]
  .filter((file) => file !== 'replay-fixtures.test.ts' && !file.endsWith('.test.ts'))
  .toSorted();
const replayableScenarioFiles = [
  'child-workflow.json',
  'pipe-three-stages.json',
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

const scenarioRunners: Record<string, ScenarioRunner> = {
  'simple-sequential': runFixtureWorkflow,
  'two-parallel': runFixtureWorkflow,
  'signal-and-wait': runSignalAndWaitFixture,
  'sleep-and-resume': runSleepAndResumeFixture,
  'child-workflow': runFixtureWorkflow,
  'saga-with-compensation': runFixtureWorkflow,
  'pipe-three-stages': runFixtureWorkflow,
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
    });
  }
});

describe('write-path replay', () => {
  for (const fixtureFile of replayableScenarioFiles) {
    it(`replays ${fixtureFile}`, async () => {
      await expectReplayToMatchFixture(fixtureFile);
    });
  }

  test.skip('replays race-takes-first.json', () => {
    // REPLAY-MISSING-METADATA: this fixture depends on host timer scheduling
    // inside a race and does not yet encode enough metadata to make the winner
    // deterministic without reusing the fixture generator runtime exactly.
  });

  test.skip('replays fork-from-checkpoint.json', () => {
    // REPLAY-MISSING-METADATA: this fixture covers two terminal workflows
    // produced by start(), fork(), and separate branch signals. The JSON
    // fixture only names the original workflow as finalState, so the write-path
    // contract needs explicit fork metadata before this can be a focused replay
    // assertion instead of a copy of the generator.
  });
});
