import type { ScheduleSpec } from '../../core/types.ts';
import type { OperationFault } from '../operation-fault.ts';
import { invalidParamsFault } from './operation-helpers.ts';

export { isOperationFault } from './operation-helpers.ts';

export function mapScheduleErrorToFault(scheduleId: string, error: unknown): OperationFault {
  const message = error instanceof Error ? error.message : String(error);
  const normalizedMessage = message.toLowerCase();

  if (normalizedMessage.includes('not found')) {
    return {
      code: 'NotFound',
      message,
      data: { resource: 'schedule', identifier: scheduleId },
    };
  }

  if (
    normalizedMessage.includes('already exists') ||
    normalizedMessage.includes('cannot be resumed')
  ) {
    return {
      code: 'Conflict',
      message,
      data: { reason: message },
    };
  }

  if (
    message.includes('Missing required field') ||
    normalizedMessage.includes('must be') ||
    normalizedMessage.includes('no workflow registered') ||
    normalizedMessage.includes('cron')
  ) {
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
