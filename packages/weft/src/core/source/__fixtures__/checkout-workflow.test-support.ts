/**
 * Fixture module for `core/source/**` type-level and runtime tests: a real
 * `workflow({ name }).execute(fn)` builder output with typed input/output,
 * imported via literal `() => import('./checkout-workflow.test-support.ts')`
 * so `workflowSource()`'s generic inference has real module export types to
 * work against. `.test-support.ts` so `bun run build`'s post-build
 * dangling-import guard never sees it.
 */

import { workflow } from '../../types.ts';

export const checkout = workflow({ name: 'checkout' }).execute(async function* (
  _ctx,
  input: { orderId: string },
) {
  return { shipped: true, orderId: input.orderId };
});
