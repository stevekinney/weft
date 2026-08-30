import { PayloadSizeExceededError, assertPayloadWithinLimit } from '../../core/payload-size.ts';

export type TaskResultPayloadSizeInput = {
  readonly status: 'completed' | 'failed';
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
