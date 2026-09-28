/// <reference lib="webworker" />
/**
 * Dedicated worker bootstrap for the mid-turn-crash regression test — see
 * `crash-workflow-handler.fixture.ts`'s doc for the mechanism.
 *
 * @module core/realm/__fixtures__/revision-crash-worker
 */

import {
  CRASH_WORKFLOW_NAME,
  createCrashWorkflowHandler,
} from './crash-workflow-handler.fixture.ts';
import { initializeRevisionRealmWorker } from './revision-realm-generator-worker-entry.ts';

initializeRevisionRealmWorker({
  [CRASH_WORKFLOW_NAME]: createCrashWorkflowHandler(),
});
