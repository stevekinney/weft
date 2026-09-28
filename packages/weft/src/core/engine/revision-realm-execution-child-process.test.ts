/**
 * Engine-level proof for `workflowExecutionMode: 'realm'` selecting the
 * `'child-process'` transport (COR-246's engine integration) — the same
 * `RevisionRealmRegistry`/engine path `revision-realm-execution.test.ts`
 * (R2E) already proves for the default `'worker'` transport, driven through
 * ordinary `engine.start()`/`engine.signal()` calls, with
 * `RevisionRealmConfig.transport: 'child-process'` selected per revision.
 * Registry-level and primitive-level proofs for the child-process adapter
 * itself already exist in `child-process-realm.test.ts` and
 * `realm-conformance.test.ts`; this file proves the SAME guarantees are
 * reachable through the engine, exactly mirroring R2E's own scope statement
 * for the Worker transport.
 *
 * @module core/engine/revision-realm-execution-child-process.test
 */
import { describe, expect, it } from 'bun:test';

import { MemoryStorage } from '../../storage/memory.ts';
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
} from './index.ts';
import { getInternals } from './internals.ts';
import { buildRegistrationEntry } from './registration.ts';

/**
 * Wait for `workflowId` to park on its signal, then assert exactly
 * `expectedTotal` signal waiters are registered engine-wide — see
 * `revision-realm-execution.test.ts`'s identical helper. Reaching the park
 * means spawning a real child process, importing its fixture and running a
 * turn, so it is awaited as an event rather than polled against a budget
 * (COR-1333); the test runner's per-test timeout reports a real hang.
 */
async function waitForSignalWaiter(
  engine: Engine,
  workflowId: string,
  expectedTotal: number,
): Promise<void> {
  await engine[ENGINE_WAIT_FOR_SIGNAL_WAITER_FOR_TESTING](workflowId);
  expect(engine[ENGINE_SIGNAL_WAITER_COUNT_FOR_TESTING]()).toBe(expectedTotal);
}

// Matching `order-workflow-handler.fixture.ts`'s and
// `sentinel-workflow.fixture.ts`'s own exported constants BY VALUE, as plain
// string literals, rather than importing them -- exactly
// `revision-realm-execution.test.ts`'s (R2E) own established pattern. This
// is deliberate, not incidental duplication: `sentinel-workflow.fixture.ts`
// sets its import flag as a MODULE-SCOPE side effect, so importing it here
// on the host side would defeat the very isolation this test proves.
const ORDER_WORKFLOW_NAME = 'r2e-order-workflow';
const ORDER_WORKFLOW_RELEASE_SIGNAL = 'release';
const SENTINEL_WORKFLOW_NAME = 'r2e-sentinel-workflow';
const SENTINEL_IMPORTED_FLAG = '__weftR2ESentinelWorkflowImported__';

const orderChildProcessScriptPath = new URL(
  '../realm/__fixtures__/revision-a-order-child-process.fixture.ts',
  import.meta.url,
);
const sentinelChildProcessScriptPath = new URL(
  '../realm/__fixtures__/sentinel-child-process.fixture.ts',
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

async function registerAndActivate(
  engine: Engine,
  name: string,
  revision: string,
  description: string,
): Promise<void> {
  const definition = placeholderDefinition(name, description);
  const loader = () => Promise.resolve({ [name]: definition });
  engine.registerSource(
    workflowSource({ name, location: `./${name}.ts`, exportName: name, revision }, loader),
  );
  await engine.resolveWorkflowSource(name, revision);
  const active = await engine.workflows.getActive(name);
  const result = await engine.workflows.activate(name, revision, {
    ...(active !== null && { expectedGeneration: active.generation }),
    policy: { requireExactRevision: false },
  });
  if (!result.applied) {
    throw new Error(`activate(${name}, ${revision}) was not applied: ${JSON.stringify(result)}`);
  }
}

describe("RevisionRealmExecutionStrategy (engine integration, COR-246 transport: 'child-process')", () => {
  it('never imports the workflow implementation module on the host; the child process realm does', async () => {
    expect((globalThis as Record<string, unknown>)[SENTINEL_IMPORTED_FLAG]).toBeUndefined();

    const revision = await revisionFor(placeholderDefinition(SENTINEL_WORKFLOW_NAME, 'sentinel'));
    const configByRevision = new Map<string, RevisionRealmConfig>([
      [
        revision,
        {
          workerUrl: sentinelChildProcessScriptPath,
          expectedWorkflowTypes: [SENTINEL_WORKFLOW_NAME],
          transport: 'child-process',
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

    // A spawned child process has its OWN OS process and its own module
    // registry -- nothing it imports can touch the HOST's own globalThis,
    // exactly the isolation the Worker transport's identical test proves for
    // a Worker thread's isolated global object instead.
    expect((globalThis as Record<string, unknown>)[SENTINEL_IMPORTED_FLAG]).toBeUndefined();
  });

  it('runs a workflow to completion end to end through the registry, selectable per revision independently of the default worker transport', async () => {
    const revision = await revisionFor(placeholderDefinition(ORDER_WORKFLOW_NAME, 'child-process'));
    const configByRevision = new Map<string, RevisionRealmConfig>([
      [
        revision,
        {
          workerUrl: orderChildProcessScriptPath,
          expectedWorkflowTypes: [ORDER_WORKFLOW_NAME],
          transport: 'child-process',
        },
      ],
    ]);
    const { engine } = newRealmEngine(configByRevision);
    try {
      await registerAndActivate(engine, ORDER_WORKFLOW_NAME, revision, 'child-process');
      const handle = await engine.start(ORDER_WORKFLOW_NAME, 'input-a', { id: 'r4-order-a' });
      await waitForSignalWaiter(engine, 'r4-order-a', 1);

      const registry = getInternals(engine).revisionRealmRegistry;
      expect(registry?.activeRealmCount(ORDER_WORKFLOW_NAME, revision)).toBe(1);

      await engine.signal('r4-order-a', ORDER_WORKFLOW_RELEASE_SIGNAL, 'go-a');
      const result = await handle.result();
      expect(result).toMatchObject({ revision: 'revision-a', input: 'input-a' });

      // The strategy releases the realm synchronously before it emits the
      // `completed` message that settles `handle.result()`, so the realm is
      // already gone by the time that result is observed.
      expect(registry?.activeRealmCount(ORDER_WORKFLOW_NAME, revision)).toBe(0);
    } finally {
      await engine[Symbol.asyncDispose]();
    }
  });
});
