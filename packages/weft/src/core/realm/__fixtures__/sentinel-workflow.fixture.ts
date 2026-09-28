/**
 * The "workflow implementation module" for the engine-level module-boundary
 * test (COR-249's engine integration, R2E) — proving "the host process never
 * imports the workflow implementation module in realm mode" dynamically, at
 * runtime, rather than only by static `Bun.build()` analysis (which
 * `revision-realm-module-boundary.test.ts` already covers at the primitive
 * level).
 *
 * The side effect below runs once, at module-evaluation time, in whichever
 * JavaScript realm (main thread or Worker) actually imports this file. A
 * Worker has its own isolated global object — nothing it does here is
 * visible on the HOST's `globalThis` — so this flag can only ever become
 * `true` on the host if the HOST's own thread evaluated this exact module.
 * The paired engine-level test asserts it stays `false` on the host after a
 * full, successful engine run whose real output could only have come from
 * this module's generator, proving the realm imported and ran it while the
 * host never did.
 *
 * @module core/realm/__fixtures__/sentinel-workflow
 */

import { workflow, type WorkflowContext } from '../../types.ts';

export const SENTINEL_IMPORTED_FLAG = '__weftR2ESentinelWorkflowImported__';

(globalThis as Record<string, unknown>)[SENTINEL_IMPORTED_FLAG] = true;

export const SENTINEL_WORKFLOW_NAME = 'r2e-sentinel-workflow';

export const sentinelWorkflow = workflow({ name: SENTINEL_WORKFLOW_NAME }).execute(async function* (
  _ctx: WorkflowContext,
  input: unknown,
) {
  return { sawInput: input, ranInsideRealm: true };
});
