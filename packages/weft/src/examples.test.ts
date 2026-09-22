import { describe, expect, it } from 'bun:test';

import {
  customerProfileWorkflow,
  loadCustomerProfileActivity,
} from './customer-profile.test-support.ts';
import { formatGreetingActivity, helloWorldWorkflow } from './hello-world.test-support.ts';

async function loadHelloWorldModule() {
  return import('./hello-world-example.test-support.ts');
}

describe('bundled examples', () => {
  it('trims greeting subjects before formatting the hello-world example output', async () => {
    expect(formatGreetingActivity.execute('  John  ')).resolves.toEqual({
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

    expect(iterator.next()).resolves.toEqual({
      value: { greeting: 'hello Jane' },
      done: true,
    });
  });

  it('loads a customer profile through the bundled customer-profile activity', async () => {
    expect(loadCustomerProfileActivity.execute({ customerId: '42' })).resolves.toEqual({
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

    expect(iterator.next()).resolves.toEqual({
      value: { customerId: '42', loyaltyTier: 'gold' },
      done: true,
    });
  });

  it('exercises the source hello-world example module exports directly', async () => {
    const {
      formatGreetingActivity: publishedFormatGreetingActivity,
      helloWorldWorkflow: publishedHelloWorldWorkflow,
      runHelloWorldExample,
    } = await loadHelloWorldModule();

    expect(publishedFormatGreetingActivity.execute('  Ada  ')).resolves.toEqual({
      greeting: 'hello Ada',
    });

    expect(publishedHelloWorldWorkflow.name).toBe('helloWorld');

    expect(runHelloWorldExample('Linus')).resolves.toEqual({
      greeting: 'hello Linus',
    });
  });

  it('exercises the source customer-profile example module exports directly', async () => {
    const {
      customerProfileWorkflow: publishedCustomerProfileWorkflow,
      loadCustomerProfileActivity: publishedLoadCustomerProfileActivity,
      runCustomerProfileExample,
    } = await loadHelloWorldModule();

    expect(publishedLoadCustomerProfileActivity.execute({ customerId: '84' })).resolves.toEqual({
      customerId: '84',
      loyaltyTier: 'gold',
    });

    expect(publishedCustomerProfileWorkflow.name).toBe('customerProfile');

    expect(runCustomerProfileExample('84')).resolves.toEqual({
      customerId: '84',
      loyaltyTier: 'gold',
    });
  });

  it('runs the CLI entry point (import.meta.main) when spawned directly, printing both examples', async () => {
    const weftRoot = import.meta.dir + '/..';
    const proc = Bun.spawn(['bun', 'src/hello-world-example.test-support.ts'], {
      cwd: weftRoot,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const exitCode = await proc.exited;
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();

    expect(exitCode).toBe(0);
    expect(stderr).toBe('');
    expect(stdout).toContain('"greeting": "hello Ada"');
    expect(stdout).toContain('"customerId": "42"');
    expect(stdout).toContain('"loyaltyTier": "gold"');
  }, 15_000);
});
