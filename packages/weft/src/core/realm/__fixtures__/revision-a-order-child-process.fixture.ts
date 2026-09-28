/**
 * Revision "a"'s dedicated child-process bootstrap for the engine-level
 * revision realm tests (COR-246's engine integration) — the `Bun.spawn` IPC
 * counterpart of `revision-a-order-worker.fixture.ts`, reusing the identical
 * `createOrderWorkflowHandler('revision-a')` handler so both transports'
 * engine-level tests exercise the same workflow logic.
 *
 * @module core/realm/__fixtures__/revision-a-order-child-process
 */

import {
  createOrderWorkflowHandler,
  ORDER_WORKFLOW_NAME,
} from './order-workflow-handler.fixture.ts';
import { initializeRevisionRealmChildProcess } from './revision-realm-child-process-generator-entry.ts';

initializeRevisionRealmChildProcess({
  [ORDER_WORKFLOW_NAME]: createOrderWorkflowHandler('revision-a'),
});
