/**
 * In-repo fixture copy of the `customer-profile` example workflow and activity.
 * Imports the engine relatively (`./index.ts`) for the same reason as
 * {@link file://./hello-world.test-support.ts}: the consumer example resolves
 * `from '@lostgradient/weft'` only inside its own installed workspace, so the in-repo fixture
 * keeps its own relative-import copy rather than re-exporting across the boundary
 * (which would break the root `tsc`/`bun test` jobs). Build-excluded via the
 * `.test-support.ts` suffix.
 */
import { activity, workflow } from './index.ts';

interface CustomerProfileInput {
  customerId: string;
}

interface CustomerProfileOutput {
  customerId: string;
  loyaltyTier: string;
}

export const loadCustomerProfileActivity = activity({
  name: 'loadCustomerProfile',
  idempotent: true,
  execute: async (input: CustomerProfileInput): Promise<CustomerProfileOutput> => {
    return {
      customerId: input.customerId,
      loyaltyTier: 'gold',
    };
  },
});

export const customerProfileWorkflow = workflow({ name: 'customerProfile' })
  .activities({ loadCustomerProfile: loadCustomerProfileActivity })
  .execute(async function* (context, input: CustomerProfileInput) {
    return yield* context.run('loadCustomerProfile', input);
  });
