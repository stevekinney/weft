import type { ScheduleSpec, StartOrSignalSignal } from '../core/types.ts';
import type { ClientStartOptions, ClientStartOrSignalOptions } from './interface.ts';

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

/** Copy the shared client start-option wire fields onto a request body, omitting undefined. */
function applyStartOptionsToBody(
  body: Record<string, unknown>,
  options?: ClientStartOptions,
): void {
  setIfDefined(body, 'id', options?.id);
  setIfDefined(body, 'executionTimeout', options?.executionTimeout);
  setIfDefined(body, 'startAt', options?.startAt);
  setIfDefined(body, 'startAfter', options?.startAfter);
  setIfDefined(body, 'tags', options?.tags);
  setIfDefined(body, 'idempotencyKey', options?.idempotencyKey);
  setIfDefined(body, 'searchAttributes', options?.searchAttributes);
}

export function buildStartBody(
  type: string,
  input: unknown,
  options?: ClientStartOptions,
): Record<string, unknown> {
  const body: Record<string, unknown> = { type, input };
  applyStartOptionsToBody(body, options);
  return body;
}

/**
 * Build the wire body for `weft.workflows.startorsignal`. Flattens the signal
 * spec into `signalName` / `signalPayload` / `signalId` and carries the same
 * start options as {@link buildStartBody}.
 */
export function buildStartOrSignalBody(
  type: string,
  input: unknown,
  signal: StartOrSignalSignal,
  options?: ClientStartOrSignalOptions,
): Record<string, unknown> {
  const body: Record<string, unknown> = { type, input, signalName: signal.name };
  setIfDefined(body, 'signalPayload', signal.payload);
  setIfDefined(body, 'signalId', signal.signalId);
  applyStartOptionsToBody(body, options);
  setIfDefined(body, 'onTerminalConflict', options?.onTerminalConflict);
  return body;
}
