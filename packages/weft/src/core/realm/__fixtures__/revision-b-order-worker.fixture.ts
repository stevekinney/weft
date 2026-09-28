/// <reference lib="webworker" />
/**
 * Revision "b"'s dedicated worker bootstrap — see
 * `revision-a-order-worker.fixture.ts`'s doc.
 *
 * @module core/realm/__fixtures__/revision-b-order-worker
 */

import {
  createOrderWorkflowHandler,
  ORDER_WORKFLOW_NAME,
} from './order-workflow-handler.fixture.ts';
import { initializeRevisionRealmWorker } from './revision-realm-generator-worker-entry.ts';

initializeRevisionRealmWorker({
  [ORDER_WORKFLOW_NAME]: createOrderWorkflowHandler('revision-b'),
});
