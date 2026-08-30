/**
 * Pre-acceptance validation for workflow updates: running a registered
 * `updateValidators` entry and normalizing a Standard Schema v1 failure result
 * into the issue list `UpdateValidationError` carries.
 *
 * Lives apart from `updates.ts` because it is shared — `pending-updates.ts`
 * normalizes validator results through the same helper — and because it is
 * pure payload validation with no coupling to the in-memory waiter maps or the
 * durable coordinated-update protocol that make up the rest of update delivery.
 *
 * @module core/engine/update-validation
 */

import { UpdateValidationError } from '../updates.ts';
import type { EngineInternals } from './internals.ts';

/**
 * Run the pre-acceptance validator for an update, if one is registered.
 * Throws `UpdateValidationError` if the validator rejects (by throwing or by
 * returning a Standard Schema `{ issues: [...] }` failure result).
 */
export async function runUpdateValidator(
  internals: EngineInternals,
  workflowId: string,
  name: string,
  payload: unknown,
): Promise<void> {
  const validator = internals.inlineStrategy?.getContext(workflowId)?.updateValidators.get(name);
  if (validator === undefined) return;

  let result: unknown;
  try {
    result = await validator(payload);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new UpdateValidationError(name, [{ message }]);
  }

  const issues = extractStandardSchemaIssues(result);
  if (issues !== null && issues.length > 0) {
    throw new UpdateValidationError(name, issues);
  }
}

/**
 * Extract issues from a Standard Schema v1 failure result, or null if absent.
 * No string-`message` entries yields `[]`; callers reject only on a non-empty
 * array, so `null` and `[]` both mean acceptance. Preserves `path` (RFC 6901).
 */
export function extractStandardSchemaIssues(
  result: unknown,
): Array<{ message: string; path?: string }> | null {
  if (result === null || typeof result !== 'object' || !('issues' in result)) return null;
  const { issues } = result;
  if (!Array.isArray(issues)) return null;
  return issues.flatMap((issue: unknown) => {
    if (issue === null || typeof issue !== 'object') return [];
    const obj = issue as Record<string, unknown>;
    if (typeof obj['message'] !== 'string') return [];
    const entry: { message: string; path?: string } = { message: obj['message'] };
    if (Array.isArray(obj['path']) && obj['path'].length > 0) {
      entry.path = (obj['path'] as unknown[]).reduce((p: string, seg: unknown) => {
        const k =
          seg !== null && typeof seg === 'object' && 'key' in (seg as Record<string, unknown>)
            ? String((seg as { key: unknown }).key)
            : String(seg);
        return p + '/' + k.replace(/~/g, '~0').replace(/\//g, '~1');
      }, '');
    }
    return [entry];
  });
}
