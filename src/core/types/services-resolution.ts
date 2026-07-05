/**
 * Result of {@link EngineOptions.resolveWorkflowServices}. An explicit union
 * rather than a nullable return: `'unavailable'` is a deliberate, named outcome
 * (the run's dependencies cannot be rebuilt in this process) that fails just
 * that recovered run — it does not overload the resolved value with a lifecycle
 * signal.
 *
 * @example
 * ```ts
 * import { type WorkflowServicesResolution } from '@lostgradient/weft';
 *
 * const ok: WorkflowServicesResolution = {
 *   status: 'available',
 *   services: { db: { query: () => [] } },
 * };
 * const no: WorkflowServicesResolution = { status: 'unavailable', reason: 'no config' };
 * void ok;
 * void no;
 * ```
 */
export type WorkflowServicesResolution<TServices = unknown> =
  | { status: 'available'; services: TServices }
  | { status: 'unavailable'; reason: string };

/**
 * Durable launch context passed to {@link EngineOptions.resolveWorkflowServices}
 * when it is available before the workflow body advances.
 *
 * `tags` reflects the workflow's current durable tag set, not necessarily the
 * exact tag list supplied at launch, because callers can mutate tags after
 * start.
 *
 * @example
 * ```ts
 * import { type WorkflowServicesResolverLaunchOptions } from '@lostgradient/weft';
 *
 * const launchOptions: WorkflowServicesResolverLaunchOptions = {
 *   id: 'checkout-123',
 *   tags: ['tenant:acme'],
 * };
 * void launchOptions;
 * ```
 */
export interface WorkflowServicesResolverLaunchOptions {
  id: string;
  tags?: string[];
}

/**
 * Schedule context passed to {@link EngineOptions.resolveWorkflowServices} for
 * scheduled occurrences. New scheduled runs persist this context with the
 * workflow record, so a fresh-process recovery receives the same schedule id and
 * known occurrence timestamp as the live launch path. Runs from older stores
 * that predate the metadata may omit it, and queue-drained runs may omit
 * `occurrence` because their original grid timestamp was not retained.
 *
 * @example
 * ```ts
 * import { type WorkflowServicesResolverScheduleInfo } from '@lostgradient/weft';
 *
 * const schedule: WorkflowServicesResolverScheduleInfo = {
 *   id: 'nightly-reconciliation',
 *   occurrence: Date.parse('2026-01-01T00:00:00.000Z'),
 * };
 * void schedule;
 * ```
 */
export interface WorkflowServicesResolverScheduleInfo {
  id: string;
  occurrence?: number;
}

/**
 * Information passed to {@link EngineOptions.resolveWorkflowServices} for each
 * recovered workflow or scheduled occurrence. `input` is the original durable
 * launch input, available at resume time — typically enough to rebuild the run's
 * dependencies (tenant, model, tool registry) without a side table. When tags or
 * schedule identity are part of the durable launch context, they are exposed on
 * both live scheduled launches and recovery so resolvers do not need parallel
 * side channels for the same classification.
 *
 * @example
 * ```ts
 * import { type WorkflowServicesResolverInfo } from '@lostgradient/weft';
 *
 * function describe(info: WorkflowServicesResolverInfo): string {
 *   return `${info.workflowType}/${info.workflowId}`;
 * }
 * ```
 */
export interface WorkflowServicesResolverInfo {
  workflowId: string;
  workflowType: string;
  input: unknown;
  launchOptions?: WorkflowServicesResolverLaunchOptions;
  schedule?: WorkflowServicesResolverScheduleInfo;
}
