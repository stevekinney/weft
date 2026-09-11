import {
  isValidScheduleOverlapPolicy,
  isValidScheduleRevisionPolicy,
  normalizeScheduleUpdateOptions,
} from '../../core/engine/validation/schedule.ts';
import type { ScheduleSpec, ScheduleUpdateOptions } from '../../core/types.ts';
import type { OperationFault } from '../operation-fault.ts';
import { invalidParamsFault } from './operation-helpers.ts';
import { mapRevisionUnavailableToFault } from './revision-unavailable-fault.ts';

export { isOperationFault } from './operation-helpers.ts';

export type ScheduleMutableOptionsInput = {
  description?: unknown;
  overlap?: unknown;
  backfill?: unknown;
  jitter?: unknown;
  revisionPolicy?: unknown;
};

/** Validate the mutable schedule options shared by create and update. */
export function validateScheduleMutableOptions(
  input: ScheduleMutableOptionsInput,
): ScheduleUpdateOptions {
  const description = validateScheduleDescription(input.description);
  const overlap = validateScheduleOverlap(input.overlap);
  const backfill = validateScheduleBackfill(input.backfill);
  const jitter = validateScheduleJitter(input.jitter);
  const revisionPolicy = validateScheduleRevisionPolicy(input.revisionPolicy);

  return {
    ...(description !== undefined ? { description } : {}),
    ...(overlap !== undefined ? { overlap } : {}),
    ...(backfill !== undefined ? { backfill } : {}),
    ...(jitter !== undefined ? { jitter } : {}),
    ...(revisionPolicy !== undefined ? { revisionPolicy } : {}),
  };
}

function validateScheduleDescription(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    throw invalidParamsFault('Field "description" must be a string');
  }
  return value;
}

function validateScheduleOverlap(value: unknown): ScheduleUpdateOptions['overlap'] {
  if (value === undefined) return undefined;
  if (!isValidScheduleOverlapPolicy(value)) {
    throw invalidParamsFault('Field "overlap" must be one of skip, queue, cancel-running, allow');
  }
  return value;
}

function validateScheduleRevisionPolicy(value: unknown): ScheduleUpdateOptions['revisionPolicy'] {
  if (value === undefined) return undefined;
  if (!isValidScheduleRevisionPolicy(value)) {
    throw invalidParamsFault('Field "revisionPolicy" must be one of active-at-fire, pinned');
  }
  return value;
}

function validateScheduleBackfill(value: unknown): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') {
    throw invalidParamsFault('Field "backfill" must be a boolean');
  }
  return value;
}

function validateScheduleJitter(value: unknown): ScheduleUpdateOptions['jitter'] {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw invalidParamsFault(
      'Field "jitter" must be a duration string or a number of milliseconds',
    );
  }

  try {
    normalizeScheduleUpdateOptions({ jitter: value });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw invalidParamsFault(formatJitterValidationMessage(message));
  }
  return value;
}

function formatJitterValidationMessage(message: string): string {
  const enginePrefix = 'Invalid options.jitter: ';
  const hasEnginePrefix = message.startsWith(enginePrefix);
  const detail = hasEnginePrefix ? message.slice(enginePrefix.length) : message;
  const wireDetail = detail.replaceAll('options.jitter', 'Field "jitter"');
  return hasEnginePrefix ? `Field "jitter" is invalid: ${wireDetail}` : wireDetail;
}

function isScheduleConflictMessage(normalizedMessage: string): boolean {
  return (
    normalizedMessage.includes('already exists') || normalizedMessage.includes('cannot be resumed')
  );
}

function isScheduleInvalidParamsMessage(message: string, normalizedMessage: string): boolean {
  return (
    message.includes('Missing required field') ||
    normalizedMessage.includes('must be') ||
    normalizedMessage.includes('no workflow registered') ||
    normalizedMessage.includes('cron') ||
    normalizedMessage.includes('interval')
  );
}

export function mapScheduleErrorToFault(scheduleId: string, error: unknown): OperationFault {
  const revisionFault = mapRevisionUnavailableToFault(error);
  if (revisionFault !== undefined) {
    return revisionFault;
  }

  const message = error instanceof Error ? error.message : String(error);
  const normalizedMessage = message.toLowerCase();

  if (normalizedMessage.includes('not found')) {
    return {
      code: 'NotFound',
      message,
      data: { resource: 'schedule', identifier: scheduleId },
    };
  }

  if (isScheduleConflictMessage(normalizedMessage)) {
    return {
      code: 'Conflict',
      message,
      data: { reason: message },
    };
  }

  if (isScheduleInvalidParamsMessage(message, normalizedMessage)) {
    return {
      code: 'InvalidParams',
      message,
      data: { issues: [] },
    };
  }

  return {
    code: 'EngineFailure',
    message,
    data: {},
  };
}

/**
 * Validate the mutually exclusive schedule cadence fields (`cronExpression` or
 * `every`) present on both create and update inputs. Exactly one must be
 * supplied. Throws an `InvalidParams` fault on the first validation failure so
 * REST and JSON-RPC callers receive identical error messages.
 */
export function validateScheduleInputCadence(input: {
  cronExpression?: unknown;
  every?: unknown;
}): ScheduleSpec {
  const hasCron = input.cronExpression !== undefined;
  const hasEvery = input.every !== undefined;

  if (hasCron && hasEvery) {
    throw invalidParamsFault('Provide exactly one of cronExpression or every, not both');
  }

  if (hasEvery) {
    if (typeof input.every !== 'string' && typeof input.every !== 'number') {
      throw invalidParamsFault(
        'Field "every" must be a duration string or a number of milliseconds',
      );
    }
    return { every: input.every };
  }

  if (typeof input.cronExpression !== 'string' || input.cronExpression.length === 0) {
    throw invalidParamsFault('Missing required field: cronExpression or every');
  }
  return { cron: input.cronExpression };
}
