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
 * Information passed to {@link EngineOptions.resolveWorkflowServices} for each
 * recovered workflow. `input` is the original durable launch input, available
 * at resume time — typically enough to rebuild the run's dependencies (tenant,
 * model, tool registry) without a side table.
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
}
