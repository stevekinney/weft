import { describe, expect, it } from 'bun:test';

import {
  customerProfileWorkflow,
  loadCustomerProfileActivity,
} from './customer-profile.test-support.ts';
import { formatGreetingActivity, helloWorldWorkflow } from './hello-world.test-support.ts';

async function loadPublishedHelloWorldModule(): Promise<{
  customerProfileWorkflow: {
    handler: (
      context: unknown,
      input: { customerId: string },
    ) => AsyncGenerator<{ customerId: string; loyaltyTier: string }>;
  };
  formatGreetingActivity: {
    execute: (input: string) => Promise<{ greeting: string }>;
  };
  helloWorldWorkflow: {
    handler: (context: unknown, input: string) => AsyncGenerator<{ greeting: string }>;
  };
  loadCustomerProfileActivity: {
    execute: (input: { customerId: string }) => Promise<{
      customerId: string;
      loyaltyTier: string;
    }>;
  };
  runCustomerProfileExample: (customerId?: string) => Promise<{
    customerId: string;
    loyaltyTier: string;
  }>;
  runHelloWorldExample: (subject?: string) => Promise<{ greeting: string }>;
}> {
  return (await import(new URL('../examples/hello-world/src/index.ts', import.meta.url).href)) as {
    customerProfileWorkflow: {
      handler: (
        context: unknown,
        input: { customerId: string },
      ) => AsyncGenerator<{ customerId: string; loyaltyTier: string }>;
    };
    formatGreetingActivity: {
      execute: (input: string) => Promise<{ greeting: string }>;
    };
    helloWorldWorkflow: {
      handler: (context: unknown, input: string) => AsyncGenerator<{ greeting: string }>;
    };
    loadCustomerProfileActivity: {
      execute: (input: { customerId: string }) => Promise<{
        customerId: string;
        loyaltyTier: string;
      }>;
    };
    runCustomerProfileExample: (customerId?: string) => Promise<{
      customerId: string;
      loyaltyTier: string;
    }>;
    runHelloWorldExample: (subject?: string) => Promise<{ greeting: string }>;
  };
}

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

  it('exercises the published hello-world example module exports directly', async () => {
    const {
      formatGreetingActivity: publishedFormatGreetingActivity,
      helloWorldWorkflow: publishedHelloWorldWorkflow,
      runHelloWorldExample,
    } = await loadPublishedHelloWorldModule();

    await expect(publishedFormatGreetingActivity.execute('  Ada  ')).resolves.toEqual({
      greeting: 'hello Ada',
    });

    const helloWorldIterator = publishedHelloWorldWorkflow.handler(
      {
        run: async function* (activityName: string, input: string) {
          if (activityName !== 'formatGreeting') {
            throw new Error(`unexpected activity ${activityName}`);
          }
          return await publishedFormatGreetingActivity.execute(input);
        },
      } as never,
      '  Grace  ',
    );
    await expect(helloWorldIterator.next()).resolves.toEqual({
      value: { greeting: 'hello Grace' },
      done: true,
    });

    await expect(runHelloWorldExample('Linus')).resolves.toEqual({
      greeting: 'hello Linus',
    });
  });

  it('exercises the published customer-profile example module exports directly', async () => {
    const {
      customerProfileWorkflow: publishedCustomerProfileWorkflow,
      loadCustomerProfileActivity: publishedLoadCustomerProfileActivity,
      runCustomerProfileExample,
    } = await loadPublishedHelloWorldModule();

    await expect(
      publishedLoadCustomerProfileActivity.execute({ customerId: '84' }),
    ).resolves.toEqual({
      customerId: '84',
      loyaltyTier: 'gold',
    });

    const customerProfileIterator = publishedCustomerProfileWorkflow.handler(
      {
        run: async function* (activityName: string, input: { customerId: string }) {
          if (activityName !== 'loadCustomerProfile') {
            throw new Error(`unexpected activity ${activityName}`);
          }
          return await publishedLoadCustomerProfileActivity.execute(input);
        },
      } as never,
      { customerId: '84' },
    );
    await expect(customerProfileIterator.next()).resolves.toEqual({
      value: { customerId: '84', loyaltyTier: 'gold' },
      done: true,
    });

    await expect(runCustomerProfileExample('84')).resolves.toEqual({
      customerId: '84',
      loyaltyTier: 'gold',
    });
  });
});
