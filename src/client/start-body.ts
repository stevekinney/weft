import type { ScheduleSpec, StartOptions } from '../core/types.ts';

export function setIfDefined(body: Record<string, unknown>, key: string, value: unknown): void {
  if (value !== undefined) body[key] = value;
}

/**
 * Translate a schedule recurrence specification into the wire body fields the
 * REST/JSON-RPC schedule operations accept. A bare string is sent as
 * `cronExpression`; an interval spec is sent as `every`.
 */
export function scheduleSpecToWireFields(spec: string | ScheduleSpec): Record<string, unknown> {
  if (typeof spec === 'string') {
    return { cronExpression: spec };
  }
  if (spec.every !== undefined) {
    return { every: spec.every };
  }
  return { cronExpression: spec.cron };
}

export function buildStartBody(
  type: string,
  input: unknown,
  options?: StartOptions,
): Record<string, unknown> {
  if (options?.idempotencyKey !== undefined) {
    throw new Error(
      'idempotencyKey is not supported over HttpClient because the start workflow HTTP protocol does not implement start idempotency',
    );
  }

  const body: Record<string, unknown> = { type, input };
  setIfDefined(body, 'id', options?.id);
  setIfDefined(body, 'executionTimeout', options?.executionTimeout);
  setIfDefined(body, 'startAt', options?.startAt);
  setIfDefined(body, 'startAfter', options?.startAfter);
  setIfDefined(body, 'tags', options?.tags);
  setIfDefined(body, 'searchAttributes', options?.searchAttributes);
  return body;
}
