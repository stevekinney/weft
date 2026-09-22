import type { ActivityDefinition, Engine, WorkflowDefinition } from '../index.ts';

/**
 * Convert a plain-object `ActivityDefinition` into a callable function that
 * satisfies the engine's `isActivityDefinition` check (which requires a
 * function with `name` and `execute` own properties).
 */
export function toActivityCallable(definition: ActivityDefinition) {
  const { name, execute, ...metadata } = definition;
  const callable = Object.assign(
    async function activityCallable(...args: Parameters<typeof execute>) {
      return execute(...args);
    },
    metadata,
    { execute },
  );
  Object.defineProperty(callable, 'name', { value: name, configurable: true });
  Object.defineProperty(callable, 'execute', {
    value: execute,
    enumerable: true,
    configurable: true,
  });
  return callable;
}

/**
 * Register a map of workflow definitions and a list of activity definitions
 * on an engine instance. Plain-object activities are normalized to callables
 * before registration.
 */
export function registerModuleExports(
  engine: Engine,
  registrations: Record<string, WorkflowDefinition>,
  activities: ActivityDefinition[],
): void {
  for (const definition of Object.values(registrations)) {
    engine.register(definition);
  }
  for (const activity of activities) {
    if (typeof activity === 'function') {
      engine.register(activity);
    } else {
      engine.register(toActivityCallable(activity));
    }
  }
}
