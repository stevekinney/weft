import type { ScheduleAccessOptions } from '../../core/types.ts';
import type { OperationFault } from '../operation-fault.ts';
import type { Principal } from '../principal.ts';

export const MISSING_SCHEDULE_TENANT_CLAIM_MESSAGE =
  'JWT-authenticated schedule requests require a tenantId, tenant_id, or tenant claim';

/**
 * Resolve {@link ScheduleAccessOptions} for a request, or a 403 fault when a
 * JWT principal is missing the required tenant claim. Returns `undefined` for
 * non-JWT principals so the engine falls back to its default access policy.
 */
export function resolveScheduleAccessOptions(
  principal: Principal,
): OperationFault | ScheduleAccessOptions | undefined {
  if (principal.method !== 'jwt') {
    return undefined;
  }
  if (principal.tenantId === undefined) {
    return {
      code: 'Forbidden',
      message: MISSING_SCHEDULE_TENANT_CLAIM_MESSAGE,
      data: { reason: MISSING_SCHEDULE_TENANT_CLAIM_MESSAGE },
    };
  }
  return { tenantId: principal.tenantId };
}

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

  if (normalizedMessage.includes('authenticated tenant')) {
    return {
      code: 'Forbidden',
      message,
      data: { reason: message },
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
