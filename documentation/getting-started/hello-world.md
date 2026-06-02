# Hello World

Let's build a durable workflow from scratch. By the end of this page you'll have a working program that survives crashes, and you'll understand _why_ it works.

## Create a Project

Start with a fresh directory and install Weft:

```bash
mkdir weft-hello && cd weft-hello
bun init -y
bun add @lostgradient/weft
```

## The Simplest Workflow

Create a file called `index.ts` and paste this:

```typescript
import {
  Engine,
  WorkflowAlreadyExistsError,
  workflow,
  type WorkflowHandle,
} from '@lostgradient/weft';
import { SQLiteStorage } from '@lostgradient/weft/storage/sqlite';

interface HelloWorldWelcomeInput {
  name: string;
}

const helloWorldWelcome = workflow({ name: 'helloWorldWelcome' })
  .activities({
    formatGreeting: async (input: HelloWorldWelcomeInput) => `Hello, ${input.name}!`,
    sendNotification: async (input: { message: string }) => `Notified: ${input.message}`,
  })
  .execute(async function* (ctx, input: HelloWorldWelcomeInput) {
    const greeting = yield* ctx.run('formatGreeting', input);
    yield* ctx.sleep('1s');
    yield* ctx.run('sendNotification', { message: greeting });
    return { greeting, notified: true };
  });

const engine = await Engine.create({
  storage: new SQLiteStorage('./weft.db'),
  workflows: { helloWorldWelcome },
});

const workflowId = 'helloWorldWelcome:world';
const workflowInput = { name: 'World' };
let handle: WorkflowHandle;

try {
  handle = await engine.start('helloWorldWelcome', workflowInput, { id: workflowId });
} catch (error) {
  if (!(error instanceof WorkflowAlreadyExistsError)) throw error;
  handle = await engine.resume(workflowId).catch(() => engine.getHandle(workflowId));
}

const result = await handle.result();
console.log(result);
// { greeting: "Hello, World!", notified: true }
```

Run it:

```bash
bun run index.ts
```

That's a durable workflow with persistent storage and an explicit recovery path. A **workflow** is the durable process the engine drives to completion. An **activity** is a named side-effecting unit of work, such as formatting a message, calling an API, or writing to another system. Activities are declared inside the workflow's `.activities({ ... })` block so they're co-located with the workflow that uses them, and `ctx.run('name', input)` autocompletes from that block. Let's break down what just happened.

### Step-based alternative

If generators are unfamiliar, you can write the same workflow with plain `async`/`await` and compile it with `compileStepWorkflow(...)` before passing it to `.execute(...)`:

```typescript partial
import {
  Engine,
  workflow,
  compileStepWorkflow,
  type StepWorkflowContext,
} from '@lostgradient/weft';
import { SQLiteStorage } from '@lostgradient/weft/storage/sqlite';

const engine = new Engine({ storage: new SQLiteStorage('./weft.db') });

async function greet(name: string) {
  return `Hello, ${name}!`;
}

async function notify(message: string) {
  return `Notified: ${message}`;
}

engine.register(
  workflow({ name: 'helloWorldWelcome' }).execute(
    compileStepWorkflow(async (ctx: StepWorkflowContext, input: { name: string }) => {
      const greeting = await ctx.step('greet', () => greet(input.name));
      await ctx.step('notify', () => notify(greeting));
      return { greeting, notified: true };
    }),
  ),
);

const workflowInput = { name: 'World' };
const handle = await engine.start('helloWorldWelcome', workflowInput, {
  id: 'helloWorldWelcome:world',
});
const result = await handle.result();
console.log(result);
// { greeting: "Hello, World!", notified: true }
```

Each `ctx.step()` call is a checkpoint boundary. `compileStepWorkflow(...)` compiles the step-based function into the generator shape the engine runs internally. When you need features like durable timers, signals, or parallel execution, switch to the chained builder form shown above. Use `engine.register(workflow(...).execute(...))` or `engine.registerWorkflows({ ... })` to wire workflows into the engine.

## How It Works

The workflow is a **generator function**—notice the `function*` and the `yield*` keywords. If you haven't used generators much, here's the mental model: every `yield*` is a checkpoint boundary. The engine runs the generator until it hits a `yield*`, records the result of that operation, and saves the workflow's position to storage. If the process dies and restarts, the engine loads the last checkpoint and resumes from that exact point.

There's no replay happening here. Weft doesn't re-execute your workflow from the beginning and try to match up results. It literally picks up where it left off. That's why you don't need to worry about determinism—your workflow code can use `Date.now()`, `Math.random()`, or anything else. The only rule is that side effects go inside activities (the registered functions behind the names you pass to `ctx.run()`).

`ctx.run('name', input)` is how you run an **activity** through its durable dispatch boundary. You pass the activity name from the workflow's `.activities({ ... })` block (the example does this, and your editor autocompletes it) plus a serializable input. Remote workers receive that name and the serialized input—not your in-process closure—which is why you declare each activity in the workflow's `.activities({ ... })` block before you register the workflow with the engine.

> [!NOTE]
> **Checkpoint:** a serialized snapshot of the workflow's current position and local variables. Each durable operation creates a checkpoint boundary, so recovery resumes from the latest saved boundary instead of starting over.

`Engine.create()` does the registration dance for you in one call: construct the engine, register every workflow in the `workflows` map (including each workflow's `.activities({ ... })` block), and then **recover by default** — `engine.recoverAll()` runs after registration so any workflows still running from a previous process pick up where they left off. Pass `recover: false` to skip recovery (handy for tests or pre-migration inspection). The map key (`helloWorldWelcome`) is canonical — Weft validates at runtime that the key matches its definition's `name` field, so you can't accidentally register `farewell` under the key `welcome`.

`engine.start()` kicks off a new execution and returns a handle. `handle.result()` waits for the workflow to finish and gives you the output. Without `options.id`, each call gets a fresh UUID; with a stable id, the second run of this script throws `WorkflowAlreadyExistsError` instead of double-starting — which is what the `try`/`catch` block handles by resuming the existing workflow.

If you'd rather wire registration up yourself — useful for tests or dynamic plugin loading — `new Engine({ storage })`, `engine.register()`, and `await engine.recoverAll()` are the same primitives. Register every workflow before recovering; each workflow carries its own `.activities({ ... })` declarations with it.

## Adding a Sleep

Durable sleeps are one of the things that make this interesting. A normal `setTimeout` dies with the process. A Weft sleep survives restarts.

```typescript partial
engine.register(
  workflow({ name: 'onboarding' }).execute(async function* (ctx, input: { name: string }) {
    const greeting = yield* ctx.run('formatGreeting', { name: input.name });
    yield* ctx.sleep('1h');
    yield* ctx.run('sendNotification', { message: `${input.name} completed onboarding` });
    return { greeting, onboarded: true };
  }),
);
```

`yield* ctx.sleep('1h')` pauses the workflow for an hour. The engine persists a timer, and when it fires the workflow resumes. You can use compact duration strings like `'30s'`, `'5m'`, or `'2d'`, or pass milliseconds directly.

## Waiting for Signals

Workflows often need to wait for something external—a user clicking "approve," a webhook arriving, a payment confirmation. Signals handle this.

```typescript partial
const approvalSignal = signal<{ approved: boolean }>('approval');

engine.register(
  workflow({ name: 'approval' }).execute(async function* (ctx, input: { orderId: string }) {
    const approval = yield* ctx.waitForSignal(approvalSignal);
    return { orderId: input.orderId, approved: approval.approved };
  }),
);

const handle = await engine.start('approval', { orderId: 'order-1' });

// Later, from an API handler or another process:
await engine.signal(handle.id, approvalSignal, { approved: true });

const result = await handle.result();
console.log(result);
// { orderId: "order-1", approved: true }
```

`yield* ctx.waitForSignal('approval')` pauses the workflow until someone sends a signal with that name. The workflow can wait for hours, days, or weeks—the checkpoint is in storage, costing nothing while it waits. When the signal arrives, the engine loads the checkpoint and resumes.

A **signal** is fire-and-forget from the sender's perspective. If the caller needs a synchronous answer back from the workflow, use an update instead; if the caller only needs to inspect state, use a query.

## Running Activities in Parallel

When you have independent work, run it concurrently with `ctx.all()`:

```typescript partial
engine.register(
  workflow({ name: 'parallel' })
    .activities({
      double: async (input: number) => input * 2,
      triple: async (input: number) => input * 3,
    })
    .execute(async function* (ctx, input: number) {
      const [doubled, tripled] = yield* ctx.all([
        ctx.run('double', input),
        ctx.run('triple', input),
      ]);
      return { doubled, tripled };
    }),
);

const handle = await engine.start('parallel', 5);
const result = await handle.result();
console.log(result);
// { doubled: 10, tripled: 15 }
```

Both activities run concurrently and the workflow resumes when all of them complete.

## Using SQLite for Persistence

`MemoryStorage` is great for development, but everything vanishes when the process stops. For real durability, use `SQLiteStorage`:

```typescript
import { Engine } from '@lostgradient/weft';
import { SQLiteStorage } from '@lostgradient/weft/storage/sqlite';

const engine = await Engine.create({
  storage: new SQLiteStorage('./weft.db'),
});
```

Now your checkpoints live in a SQLite database on disk. Crash the process, restart it, and `Engine.create()` will resume any workflows that were running — `recoverAll()` runs by default after every activity and workflow you passed in is registered. Persistent storage keeps the bytes; recovery tells the new engine process to own the work again.

> [!IMPORTANT]
> If your storage contains running workflows whose types aren't in the `workflows` map you passed to `Engine.create`, recovery will throw `WorkflowTypeNotRegisteredForRecoveryError` listing the unknown types. This is intentional: the alternative is silently abandoning workflows mid-flight. The [Recovery and deploys guide](../guides/recovery-and-deploys.md) covers how to handle this during rolling deploys and how to drain workflows whose types you want to retire.

For quick experiments where you don't want to think about which adapter to pick, `resolveDefaultStorage()` detects Bun or Node and picks the matching SQLite backend (it's not for browsers — use `IndexedDBStorage` directly there). The path goes under the OS temp directory; production deployments should pass `storage` explicitly.

```typescript
import { Engine } from '@lostgradient/weft';
import { resolveDefaultStorage } from '@lostgradient/weft/storage/auto';

await using storage = await resolveDefaultStorage();
await using engine = await Engine.create({ storage });
```

## Next Steps

You've got the fundamentals: workflows, activities, checkpoints, sleeps, signals, parallel execution, and persistent storage. From here, the [Workflows guide](../guides/workflows.md) goes deeper on generator behavior, and the [Activities guide](../guides/activities.md) covers side effects and retries.

When you want to see those primitives working together in one production-shaped flow, open the [order processing reference example](../../examples/order-processing/README.md). It adds updates, queries, search attributes, human review, child workflows, schedules, and a runnable dashboard setup.
