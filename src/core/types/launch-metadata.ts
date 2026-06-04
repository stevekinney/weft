/**
 * Launch context for a workflow, reconstructed from its persisted state by
 * {@link WorkflowHandle.getLaunchMetadata}. Lets a caller — typically after
 * `engine.recoverAll()` — recover the original input and the launch options that
 * survive in durable state, without keeping a side table that correlates a
 * recovered workflow back to how it was started.
 *
 * `launchOptions` carries only the options recoverable *faithfully* from
 * persisted state: `id` (always) and `tags`. Deliberately excluded:
 * `executionTimeout` (state stores the absolute deadline, not the original
 * duration, so it cannot be reproduced exactly); `idempotencyKey` (no durable
 * trace); `searchAttributes` (live in their own durable index — read them via
 * {@link WorkflowHandle.getAttributes}); and `services` (non-serializable,
 * re-provided on recovery by {@link EngineOptions.resolveWorkflowServices}).
 *
 * @example
 * ```ts
 * import { type LaunchMetadata } from '@lostgradient/weft';
 *
 * function describe(metadata: LaunchMetadata): string {
 *   return `input=${JSON.stringify(metadata.input)} id=${metadata.launchOptions.id}`;
 * }
 * ```
 */
export interface LaunchMetadata {
  input: unknown;
  launchOptions: {
    id: string;
    tags?: string[];
  };
}
