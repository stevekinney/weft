import type { Engine } from './engine.ts';
import type { ActivityFunction, AnyWorkflowDefinition, WorkflowRegistryEntry } from './types.ts';

type RuntimeWorkflowRegistry = Record<string, WorkflowRegistryEntry>;
type RuntimeActivityTypes = Record<string, ActivityFunction>;

export type RuntimeWorkflowEngine = Engine<RuntimeWorkflowRegistry, RuntimeActivityTypes>;

export function runtimeWorkflowEngine(engine: unknown): RuntimeWorkflowEngine {
  // Transport adapters receive workflow names from validated runtime payloads.
  // The runtime Engine still enforces registration; this helper is the one
  // type escape hatch from compile-time registries to that dynamic surface.
  return engine as RuntimeWorkflowEngine;
}

/**
 * Register a workflow definition on a runtime-typed engine view, bypassing the
 * `WorkflowAlreadyRegistered` parameter-position guard. The runtime engine
 * types every workflow name as already-present, so the brand always intersects
 * — but transport adapters, schedule-driven loaders, and benchmark harnesses
 * legitimately need to dispatch into the same dynamic surface. This helper is
 * the documented escape hatch.
 */
export function registerOnRuntimeEngine(
  engine: RuntimeWorkflowEngine,
  definition: AnyWorkflowDefinition,
): void {
  (engine.register as (workflow: AnyWorkflowDefinition) => unknown)(definition);
}
