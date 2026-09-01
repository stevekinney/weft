// Type-level regression pin: `WorkflowContractSource` must accept a real
// `workflow({...}).execute(fn)` result directly, with no cast — including
// one that declares `.activities({...})` and a `finalizer`. The finalizer
// case is the load-bearing one: `WorkflowDefinition.finalizer` is declared
// as the narrower `AnyActivityDefinition` (no `inputSchema`/`outputSchema`
// in its declared shape), so `WorkflowContractActivitySource` requires
// `name` specifically to keep TypeScript's weak-type check from firing (see
// that type's JSDoc in `types.ts`).

import { activity } from '../types/activity.ts';
import { workflow } from '../types/workflow-function.ts';
import { buildWorkflowContract } from './build.ts';
import type { WorkflowContractSource } from './types.ts';

const cleanup = activity({
  name: 'cleanup',
  execute: async (input: { orderId: string }) => {
    void input;
  },
});

const withActivitiesAndFinalizer = workflow({
  name: 'checkoutTypeCheck',
  version: '1.0.0',
  finalizer: cleanup,
})
  .activities({
    charge: activity({
      name: 'charge',
      execute: async (input: { amount: number }) => ({ id: 'ch_1', amount: input.amount }),
    }),
  })
  .execute(async function* (_ctx, input: { cartId: string }) {
    return { orderId: input.cartId };
  });

// A `BuiltWorkflowDefinition` (with activities AND a finalizer) is directly
// assignable — no cast. `finalizer` is the load-bearing case (see file header).
const sourceFromBuilt: WorkflowContractSource = withActivitiesAndFinalizer;
void buildWorkflowContract(sourceFromBuilt);

const bareWorkflow = workflow({ name: 'bareTypeCheck' }).execute(async function* () {
  return 1;
});
// A bare `WorkflowDefinition` (no activities/finalizer declared) is also
// directly assignable.
const sourceFromBare: WorkflowContractSource = bareWorkflow;
void buildWorkflowContract(sourceFromBare);
