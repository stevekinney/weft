/** Source example definitions retained as CLI validation and schedule fixtures. */
import { activity, workflow } from '../../../../../index.ts';

// --- hello-world -----------------------------------------------------------

export const formatGreetingActivity = activity({
  name: 'formatGreeting',
  idempotent: true,
  execute: async (input: string) => {
    const subject = input.trim() || 'world';
    return { greeting: `hello ${subject}` };
  },
});

export const helloWorldWorkflow = workflow({ name: 'helloWorld' })
  .activities({ formatGreeting: formatGreetingActivity })
  .execute(async function* (context, input: string) {
    return yield* context.run('formatGreeting', input);
  });

// --- customer-profile ------------------------------------------------------

export interface CustomerProfileInput {
  customerId: string;
}

export interface CustomerProfileOutput {
  customerId: string;
  loyaltyTier: string;
}

export const loadCustomerProfileActivity = activity({
  name: 'loadCustomerProfile',
  idempotent: true,
  execute: async (input: CustomerProfileInput): Promise<CustomerProfileOutput> => {
    return { customerId: input.customerId, loyaltyTier: 'gold' };
  },
});

export const customerProfileWorkflow = workflow({ name: 'customerProfile' })
  .activities({ loadCustomerProfile: loadCustomerProfileActivity })
  .execute(async function* (context, input: CustomerProfileInput) {
    return yield* context.run('loadCustomerProfile', input);
  });
