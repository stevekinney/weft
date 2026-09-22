/**
 * The smallest end-to-end Weft example: define an activity, compose it into a
 * workflow, then run it on an in-memory engine. Run it with
 * `bun src/hello-world-example.test-support.ts` from the Weft workspace.
 *
 * It imports the engine relatively (`./index.ts`) rather than by package name.
 * A consumer-facing copy of the same example lives under `examples/` and does
 * import by package name, which is what a consumer types; this in-repo copy
 * must not, because a module inside a package that names that package resolves
 * through the package's own `exports` map to its build output, and weft's
 * `typecheck` deliberately has no build step in front of it. The specifier is
 * the difference between a file that type-checks from source and one that needs
 * `dist/` to exist first.
 */
import { Engine, MemoryStorage, activity, workflow } from './index.ts';

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

// --- runnable demo ---------------------------------------------------------

export async function runHelloWorldExample(subject = 'world'): Promise<{ greeting: string }> {
  await using engine = new Engine({ storage: new MemoryStorage() }).register(helloWorldWorkflow);
  const handle = await engine.start('helloWorld', subject);
  return await handle.result();
}

export async function runCustomerProfileExample(customerId = '42'): Promise<CustomerProfileOutput> {
  await using engine = new Engine({ storage: new MemoryStorage() }).register(
    customerProfileWorkflow,
  );
  const handle = await engine.start('customerProfile', { customerId });
  return await handle.result();
}

if (import.meta.main) {
  const greeting = await runHelloWorldExample('Ada');
  console.log(JSON.stringify(greeting, null, 2));

  const profile = await runCustomerProfileExample('42');
  console.log(JSON.stringify(profile, null, 2));
}
