/**
 * In-repo fixture copy of the `hello-world` example workflow and activity.
 *
 * The consumer-facing version lives in `examples/hello-world/` and imports from
 * the published `weft` package. This module deliberately keeps its own copy that
 * imports the engine relatively (`./index.ts`) so in-repo tests
 * (`src/examples.test.ts`) and the CLI smoke harness (`scripts/cli-smoke-main.ts`)
 * load it without the example workspace's `weft` resolution — which is only
 * present after that workspace is `bun install`ed and is therefore unavailable in
 * the root `tsc`/`bun test` jobs. Re-exporting from the example instead drags
 * `from 'weft'` into the root program and breaks CI. The small duplication is the
 * intentional cost of the in-repo-fixture vs. consumer-example split.
 *
 * The `.test-support.ts` suffix keeps it out of the build (`dist/`).
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
