/**
 * Shared generator logic for the `revision-a-order-worker.fixture.ts` /
 * `revision-b-order-worker.fixture.ts` engine-level test fixtures (COR-249's
 * engine integration, R2E). Each revision's own worker entry file imports
 * this factory with its own `revisionLabel` — sharing the yield/park
 * mechanics is not the same as sharing a Worker script: each revision still
 * gets its own dedicated bootstrap file (its own `workerUrl`), matching "one
 * realm pool per immutable artifact revision."
 *
 * Parks on a named signal (the same low-level `signal-wait` operation
 * request `src/workers/test-browser-worker.ts`'s own
 * `wait-signal-then-complete` fixture yields) so a test can prove two
 * revisions' executions are genuinely concurrent — both realms mid-turn at
 * once — via an explicit `engine.signal()` release, never a timing margin.
 *
 * @module core/realm/__fixtures__/order-workflow-handler
 */

import type { WorkerWorkflowContext } from '../../../workers/workflow-runner.ts';
import type { RevisionRealmWorkflowHandler } from './revision-realm-generator-worker-entry.ts';

export const ORDER_WORKFLOW_NAME = 'r2e-order-workflow';
export const ORDER_WORKFLOW_RELEASE_SIGNAL = 'release';

export function createOrderWorkflowHandler(revisionLabel: string): RevisionRealmWorkflowHandler {
  return async function* (ctx: WorkerWorkflowContext, input: unknown) {
    const payload: unknown = yield {
      id: `r2e-order:${ctx.workflowId}:${ORDER_WORKFLOW_RELEASE_SIGNAL}`,
      workflowId: ctx.workflowId,
      kind: 'signal-wait',
      queue: 'default',
      attempt: 1,
      retryPolicy: {
        maxAttempts: 1,
        initialBackoff: 0,
        backoffMultiplier: 1,
        maxBackoff: 0,
      },
      scheduledAt: Date.now(),
      signalName: ORDER_WORKFLOW_RELEASE_SIGNAL,
    };
    return { revision: revisionLabel, input, payload };
  };
}
