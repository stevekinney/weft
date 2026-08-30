import type { ActivityDefinition } from '../core/activity.ts';
import type { Engine } from '../core/engine.ts';
import { registerOnRuntimeEngine, runtimeWorkflowEngine } from '../core/runtime-workflow-engine.ts';
import type { WorkflowDefinition } from '../core/types.ts';

/**
 * Convert a plain-object `ActivityDefinition` into a callable function that
 * satisfies the engine's `isActivityDefinition` check (which requires a
 * function with `name` and `execute` own properties).
 */
export function toActivityCallable(
  definition: ActivityDefinition,
): (...args: unknown[]) => unknown {
  const { name, execute, ...metadata } = definition;
  const callable = Object.assign(async function activityCallable(...args: unknown[]) {
    return execute(...(args as Parameters<typeof execute>));
  }, metadata);
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
  const runtime = runtimeWorkflowEngine(engine);
  for (const definition of Object.values(registrations)) {
    registerOnRuntimeEngine(runtime, definition);
  }
  for (const activity of activities) {
    if (typeof activity === 'function') {
      engine.register(activity);
    } else {
      engine.register(toActivityCallable(activity) as never);
    }
  }
}
