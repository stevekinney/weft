/**
 * In-repo fixture copy of the `customer-profile` example workflow and activity.
 *
 * Mirrors `examples/customer-profile/`'s consumer definitions but imports the
 * engine relatively so `src/examples.test.ts` can run it without the example
 * workspace's `weft` package resolution. The `.test-support.ts` suffix keeps it
 * out of the build (`dist/`). See {@link file://./hello-world.test-support.ts}.
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
