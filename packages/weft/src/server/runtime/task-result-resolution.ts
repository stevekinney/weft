import { PayloadSizeExceededError, assertPayloadWithinLimit } from '../../core/payload-size.ts';

export type TaskResultPayloadSizeInput = {
  readonly status: 'completed' | 'failed' | 'cancelled';
  readonly value?: unknown;
  readonly error?: string | undefined;
};

function taskResultPayloadForSizeCheck(input: TaskResultPayloadSizeInput): unknown {
  return input.status === 'completed' ? input.value : (input.error ?? '');
}

export function taskResultPayloadSizeError(
  input: TaskResultPayloadSizeInput,
  maxBytes: number | null,
): PayloadSizeExceededError | null {
  try {
    assertPayloadWithinLimit(taskResultPayloadForSizeCheck(input), maxBytes, 'activity result');
    return null;
  } catch (error) {
    if (error instanceof PayloadSizeExceededError) {
      return error;
    }
    throw error;
  }
}

/**
 * Validate an `activityHeartbeat`/long-poll heartbeat request's `details`
 * (COR-226) against the same configured payload size limit `taskResult`
 * values already enforce. `details === undefined` (no heartbeat details on
 * this beat) always passes without encoding anything — mirrors
 * `assertPayloadWithinLimit`'s own `limit === null` short-circuit for the
 * common case where most heartbeats carry no details at all.
 */
export function activityHeartbeatDetailsPayloadSizeError(
  details: unknown,
  maxBytes: number | null,
): PayloadSizeExceededError | null {
  if (details === undefined) return null;
  try {
    assertPayloadWithinLimit(details, maxBytes, 'heartbeat details');
    return null;
  } catch (error) {
    if (error instanceof PayloadSizeExceededError) {
      return error;
    }
    throw error;
  }
}
