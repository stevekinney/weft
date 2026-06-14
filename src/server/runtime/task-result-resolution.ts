import { TaskResultDeadLetteredEvent } from '../../core/events.ts';
import { PayloadSizeExceededError, assertPayloadWithinLimit } from '../../core/payload-size.ts';
import type { ServeOptions } from '../index.ts';
import {
  readInflightRecord,
  transitionInflightToResolved,
  writeDeadLetteredTaskRecord,
  type DeadLetteredTaskRecord,
  type InflightRecord,
  type TaskResolutionReason,
} from '../task-state.ts';
import type { ServerContext } from './context.ts';
import { withRetry } from './retry.ts';
import { recordTaskExecutionLatencyMetric } from './task-metrics.ts';

const TASK_RESULT_RESOLUTION_RETRY_ATTEMPTS = 2;

export type TaskResultResolutionInput = {
  readonly operationId: string;
  readonly status: 'completed' | 'failed';
  readonly resolutionReason: TaskResolutionReason;
  readonly value?: unknown;
  readonly error?: string | undefined;
  readonly inflightRecord?: InflightRecord | null | undefined;
  readonly skipPayloadSizeCheck?: boolean | undefined;
};

function taskResultPayloadForSizeCheck(input: TaskResultResolutionInput): unknown {
  return input.status === 'completed' ? input.value : { message: input.error ?? '' };
}

export function taskResultPayloadSizeError(
  input: TaskResultResolutionInput,
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

export async function transitionTaskResultToResolvedWithRetry(
  context: ServerContext,
  options: ServeOptions,
  input: TaskResultResolutionInput,
): Promise<void> {
  if (input.skipPayloadSizeCheck !== true) {
    const payloadError = taskResultPayloadSizeError(input, context.payloadSizeMaxBytes);
    if (payloadError !== null) throw payloadError;
  }

  const storage = options.engine.storage;
  const resolvedAt = Date.now();
  let latestInflightRecord = input.inflightRecord;

  try {
    await withRetry(async () => {
      latestInflightRecord =
        input.inflightRecord ?? (await readInflightRecord(storage, input.operationId));
      await transitionInflightToResolved(storage, input.operationId, input.status, {
        ...(latestInflightRecord === null ? {} : { record: latestInflightRecord }),
        resolvedAt,
        resolutionReason: input.resolutionReason,
        ...(input.status === 'completed' ? { value: input.value } : { error: input.error }),
      });
    }, `transition task "${input.operationId}" to resolved`);
  } catch (error) {
    const fallbackInflightRecord =
      latestInflightRecord ??
      (await readInflightRecord(storage, input.operationId).catch(() => null));
    await writeTaskResultDeadLetter(options, input, fallbackInflightRecord);
    console.error(
      `[weft] Failed to transition task "${input.operationId}" to resolved after retries — dead-lettered:`,
      error,
    );
    return;
  }

  if (latestInflightRecord !== null && latestInflightRecord !== undefined) {
    recordTaskExecutionLatencyMetric(context.metricsCollector, latestInflightRecord, resolvedAt);
  }
}

async function writeTaskResultDeadLetter(
  options: ServeOptions,
  input: TaskResultResolutionInput,
  inflightRecord: InflightRecord | null,
): Promise<void> {
  const storageErrorCode = 'result-resolution-storage-exhausted';
  const record: DeadLetteredTaskRecord = {
    operationId: input.operationId,
    reason: storageErrorCode,
    deadLetteredAt: Date.now(),
    errorMessage: storageErrorCode,
    retryAttempts: TASK_RESULT_RESOLUTION_RETRY_ATTEMPTS,
    status: input.status,
    ...(inflightRecord?.activityName === undefined
      ? {}
      : { activityName: inflightRecord.activityName }),
    ...(inflightRecord?.queue === undefined ? {} : { queue: inflightRecord.queue }),
    ...(inflightRecord?.workerId === undefined ? {} : { workerId: inflightRecord.workerId }),
    ...(inflightRecord?.attempt === undefined ? {} : { attempt: inflightRecord.attempt }),
    ...(inflightRecord?.visibilityTimeout === undefined
      ? {}
      : { visibilityTimeout: inflightRecord.visibilityTimeout }),
    ...(inflightRecord?.workflowId === undefined ? {} : { workflowId: inflightRecord.workflowId }),
    ...(inflightRecord?.retryCount === undefined ? {} : { retryCount: inflightRecord.retryCount }),
    ...(inflightRecord?.requeueCount === undefined
      ? {}
      : { requeueCount: inflightRecord.requeueCount }),
    ...(inflightRecord?.lastRequeueReason === undefined
      ? {}
      : { lastRequeueReason: inflightRecord.lastRequeueReason }),
  };

  await writeDeadLetteredTaskRecord(options.engine.storage, record);
  options.engine.dispatchEvent(
    new TaskResultDeadLetteredEvent({
      operationId: record.operationId,
      workflowId: record.workflowId,
      activityName: record.activityName,
      queue: record.queue,
      workerId: record.workerId,
      errorMessage: record.errorMessage,
    }),
  );
}
