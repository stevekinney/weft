import { defineWorker, implementWorkflow, remoteActivity, workflow } from '../index.ts';

const sharedA = workflow({ name: 'sharedA' })
  .activities({ transform: async (input: { a: string }) => input.a.length })
  .execute(async function* (ctx, input: { a: string }) {
    return yield* ctx.run('transform', input);
  });

const sharedB = workflow({ name: 'sharedB' })
  .activities({ transform: async (input: { b: number }) => String(input.b) })
  .execute(async function* (ctx, input: { b: number }) {
    return yield* ctx.run('transform', input);
  });

implementWorkflow(sharedA, {
  activities: {
    transform: async (input) => input.a.length,
  },
});

// @ts-expect-error missing required activity implementation.
implementWorkflow(sharedA, { activities: {} });

implementWorkflow(sharedA, {
  activities: {
    transform: async (input) => input.a.length,
    // @ts-expect-error undeclared activity key is rejected.
    extra: async () => null,
  },
});

implementWorkflow(sharedA, {
  activities: {
    // @ts-expect-error implementation result must match the activity output.
    transform: async () => 'wrong',
  },
});

implementWorkflow(sharedA, {
  activities: {
    // @ts-expect-error shared activity key keeps workflow A's own input type.
    transform: async (input: { b: number }) => input.b,
  },
});

implementWorkflow(sharedB, {
  activities: {
    transform: async (input) => String(input.b),
  },
});

const remote = remoteActivity<{ name: string }, string, 'sendEmail'>({ name: 'sendEmail' });
// @ts-expect-error remote declarations carry no local execute fallback.
remote.execute;

const worker = defineWorker({
  deployment: 'typed-worker',
  workflows: {
    sharedA: implementWorkflow(sharedA, {
      activities: { transform: async (input) => input.a.length },
    }),
    sharedB: implementWorkflow(sharedB, {
      activities: { transform: async (input) => String(input.b) },
    }),
  },
});

void worker;
