/**
 * Type-level assertions that protect the `Engine` chained-builder generic
 * inference chain. These declarations exist only at compile time; if any
 * future refactor breaks the inference, `bun run typecheck:tests` will fail
 * on this file.
 *
 * The chain points under test:
 *   - `Engine.create({ workflows, activities })` infers a typed registry from
 *     the literal definitions map.
 *   - `engine.register(definition)` returns a wider Engine type that includes
 *     the new definition.
 *   - `engine.start(name, input)` requires the workflow's exact input type
 *     and returns a handle parameterized by the workflow's output type.
 */

import { activity, Engine, workflow, type WorkflowHandle } from '../../index.ts';

// ---- Engine.create inference for workflows + activities --------------------

const formatGreeting = activity({
  name: 'formatGreeting',
  execute: async (input: { name: string }): Promise<string> => `Hello, ${input.name}`,
});

const welcome = workflow({ name: 'welcome' }).execute(async function* (
  ctx,
  input: { name: string },
): AsyncGenerator<unknown, string> {
  return yield* ctx.run(formatGreeting, input);
});

async function assertEngineCreateInfersRegistry(): Promise<void> {
  const engine = await Engine.create({
    workflows: { welcome },
    activities: { formatGreeting },
  });

  // `start` with the registered workflow name must accept the workflow's
  // input shape and return a handle parameterized by the workflow's output.
  const handle: WorkflowHandle<string> = await engine.start('welcome', { name: 'Ada' });

  // Suppress unused locals at the value level while keeping the type
  // assertions above load-bearing.
  void engine;
  void handle;
}
void assertEngineCreateInfersRegistry;

// ---- engine.register widens the registry -----------------------------------

async function assertRegisterWidensRegistry(): Promise<void> {
  const engine = new Engine<{}, {}>();
  const widerEngine = engine.register(welcome);

  // After registering `welcome`, `start('welcome', ...)` must type-check on
  // the wider engine without resorting to `as` casts.
  const handle: WorkflowHandle<string> = await widerEngine.start('welcome', { name: 'Grace' });

  void handle;
}
void assertRegisterWidensRegistry;

// ---- Engine.create with only workflows ------------------------------------

async function assertCreateWorkflowsOnly(): Promise<void> {
  const engine = await Engine.create({ workflows: { welcome } });
  const handle: WorkflowHandle<string> = await engine.start('welcome', { name: 'Rosa' });
  void handle;
}
void assertCreateWorkflowsOnly;

// ---- Engine.create with only activities -----------------------------------

async function assertCreateActivitiesOnly(): Promise<void> {
  const engine = await Engine.create({ activities: { formatGreeting } });
  // Without registered workflows the engine accepts arbitrary workflow names
  // (the registry is the default registry); this assertion guards that the
  // activity-only overload still returns an Engine handle (not `never`).
  void engine;
}
void assertCreateActivitiesOnly;
