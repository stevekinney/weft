import { activity, workflow } from 'weft';

const formatGreetingActivity = activity({
  name: 'formatGreeting',
  execute: async (subject: string) => ({ greeting: `hello ${subject.trim()}` }),
});

export const helloWorldWorkflow = workflow({ name: 'helloWorld' }).execute(async function* (
  context,
  subject: string,
): AsyncGenerator<unknown, { greeting: string }> {
  return yield* context.run(formatGreetingActivity, subject);
});
