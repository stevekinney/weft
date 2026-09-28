/// <reference lib="webworker" />
/**
 * Revision "a"'s dedicated worker bootstrap for the engine-level revision
 * realm tests (COR-249's engine integration, R2E) — its own build importing
 * its own revision's workflow logic, matching ADR 0004's "one workerUrl per
 * revision."
 *
 * @module core/realm/__fixtures__/revision-a-order-worker
 */

import {
  createOrderWorkflowHandler,
  ORDER_WORKFLOW_NAME,
} from './order-workflow-handler.fixture.ts';
import { initializeRevisionRealmWorker } from './revision-realm-generator-worker-entry.ts';

initializeRevisionRealmWorker({
  [ORDER_WORKFLOW_NAME]: createOrderWorkflowHandler('revision-a'),
});
