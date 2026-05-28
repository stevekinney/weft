/**
 * In-repo fixture copies of the `hello-world` example workflow and activity.
 *
 * The consumer-facing version lives in `examples/hello-world/` and imports from
 * the published `weft` package. This module exists so in-repo tests
 * (`src/examples.test.ts`) and the CLI smoke harness (`scripts/cli-smoke-main.ts`)
 * can exercise the same definitions without depending on the example workspace's
 * `weft` package resolution — it imports the engine relatively instead. The
 * `.test-support.ts` suffix keeps it out of the build (`dist/`).
 */
import { activity, workflow } from './index.ts';

export const formatGreetingActivity = activity({
  name: 'formatGreeting',
  idempotent: true,
  execute: async (input: string) => {
    const subject = input.trim() || 'world';
    return {
      greeting: `hello ${subject}`,
    };
  },
});

export const helloWorldWorkflow = workflow({ name: 'helloWorld' })
  .activities({ formatGreeting: formatGreetingActivity })
  .execute(async function* (context, input: string) {
    return yield* context.run('formatGreeting', input);
  });
