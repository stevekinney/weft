import { describe, expect, it } from 'bun:test';

import {
  customerProfileWorkflow,
  loadCustomerProfileActivity,
} from './customer-profile.test-support.ts';
import { formatGreetingActivity, helloWorldWorkflow } from './hello-world.test-support.ts';

describe('bundled examples', () => {
  it('trims greeting subjects before formatting the hello-world example output', async () => {
    await expect(formatGreetingActivity.execute('  John  ')).resolves.toEqual({
      greeting: 'hello John',
    });
  });

  it('runs the hello-world workflow through its activity', async () => {
    const iterator = helloWorldWorkflow.handler(
      {
        run: async function* (activityName: string, input: string) {
          if (activityName !== 'formatGreeting') {
            throw new Error(`unexpected activity ${activityName}`);
          }
          return await formatGreetingActivity.execute(input);
        },
      } as never,
      '  Jane  ',
    );

    await expect(iterator.next()).resolves.toEqual({
      value: { greeting: 'hello Jane' },
      done: true,
    });
  });

  it('loads a customer profile through the bundled customer-profile activity', async () => {
    await expect(loadCustomerProfileActivity.execute({ customerId: '42' })).resolves.toEqual({
      customerId: '42',
      loyaltyTier: 'gold',
    });

    const iterator = customerProfileWorkflow.handler(
      {
        run: async function* (activityName: string, input: { customerId: string }) {
          if (activityName !== 'loadCustomerProfile') {
            throw new Error(`unexpected activity ${activityName}`);
          }
          return await loadCustomerProfileActivity.execute(input);
        },
      } as never,
      { customerId: '42' },
    );

    await expect(iterator.next()).resolves.toEqual({
      value: { customerId: '42', loyaltyTier: 'gold' },
      done: true,
    });
  });
});
