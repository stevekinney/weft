/// <reference lib="webworker" />
/**
 * The realm-side worker bootstrap for the module-boundary engine test — the
 * ONLY file in this test scenario that imports `sentinel-workflow.fixture.ts`
 * (the "workflow implementation module"). See that module's doc for the
 * mechanism this proves.
 *
 * @module core/realm/__fixtures__/sentinel-worker
 */

import type { WorkerWorkflowContext } from '../../../workers/workflow-runner.ts';
import { initializeRevisionRealmWorker } from './revision-realm-generator-worker-entry.ts';
import { SENTINEL_WORKFLOW_NAME } from './sentinel-workflow.fixture.ts';

initializeRevisionRealmWorker({
  [SENTINEL_WORKFLOW_NAME]: async function* (_ctx: WorkerWorkflowContext, input: unknown) {
    return { sawInput: input, ranInsideRealm: true };
  },
});
