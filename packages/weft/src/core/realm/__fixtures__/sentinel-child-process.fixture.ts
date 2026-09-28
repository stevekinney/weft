/**
 * The realm-side child-process bootstrap for the module-boundary engine
 * test (COR-246's engine integration) — the `Bun.spawn` IPC counterpart of
 * `sentinel-worker.fixture.ts`. The ONLY file in this test scenario that
 * imports `sentinel-workflow.fixture.ts` (the "workflow implementation
 * module") for the child-process transport. See that module's doc for the
 * mechanism this proves — a spawned child process has its own OS process
 * and its own V8/JSC heap, so nothing it imports can touch the HOST
 * process's `globalThis` any more than a Worker thread's isolated global
 * object can.
 *
 * @module core/realm/__fixtures__/sentinel-child-process
 */

import type { WorkerWorkflowContext } from '../../../workers/workflow-runner.ts';
import { initializeRevisionRealmChildProcess } from './revision-realm-child-process-generator-entry.ts';
import { SENTINEL_WORKFLOW_NAME } from './sentinel-workflow.fixture.ts';

initializeRevisionRealmChildProcess({
  [SENTINEL_WORKFLOW_NAME]: async function* (_ctx: WorkerWorkflowContext, input: unknown) {
    return { sawInput: input, ranInsideRealm: true };
  },
});
