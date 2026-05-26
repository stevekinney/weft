import { WeftError } from '../weft-error.ts';

/**
 * Thrown by the engine during `engine.start` when a tenant's configured quota
 * is breached. Inspect `quota` to see which limit was hit
 * (`'maxConcurrentWorkflows'`, `'maxWorkflowCreationRate'`, or
 * `'maxStorageBytes'`), and `currentUsage`/`limit` for the relevant numbers.
 *
 * @example
 * ```ts
 * import { workflow, Engine, QuotaExceededError } from 'weft';
 *
 * const engine = new Engine({
 *   quotas: { maxConcurrentWorkflows: 1 },
 * });
 * engine.register(workflow({ name: 'ping' }).execute(async function* () { return 'pong'; }));
 * try {
 *   await engine.start('ping', null);
 *   await engine.start('ping', null); // may throw if tenant limit reached
 * } catch (err) {
 *   if (err instanceof QuotaExceededError) {
 *     console.error('quota exceeded:', err.quota, err.currentUsage, '/', err.limit);
 *   }
 * }
 * ```
 */
export class QuotaExceededError extends WeftError<'QuotaExceededError'> {
  readonly tenantId: string;
  readonly quota: 'maxConcurrentWorkflows' | 'maxWorkflowCreationRate' | 'maxStorageBytes';
  readonly currentUsage: number;
  readonly limit: number;
  readonly windowMilliseconds: number | null;

  constructor(parameters: {
    tenantId: string;
    quota: 'maxConcurrentWorkflows' | 'maxWorkflowCreationRate' | 'maxStorageBytes';
    currentUsage: number;
    limit: number;
    windowMilliseconds?: number | null;
  }) {
    const { tenantId, quota, currentUsage, limit, windowMilliseconds = null } = parameters;
    const windowDescription =
      quota === 'maxWorkflowCreationRate' && windowMilliseconds !== null
        ? ` in ${windowMilliseconds}ms`
        : '';

    super(
      'QuotaExceededError',
      `Tenant quota exceeded for "${tenantId}": ${quota} current usage ${currentUsage} exceeds limit ${limit}${windowDescription}`,
    );
    this.tenantId = tenantId;
    this.quota = quota;
    this.currentUsage = currentUsage;
    this.limit = limit;
    this.windowMilliseconds = windowMilliseconds;
  }
}
