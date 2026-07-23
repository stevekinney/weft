import type { RestInputContext } from '../rest-binding.ts';
import { readRestJsonBody } from '../rest-body.ts';
import { invalidParamsFault, isOperationFault } from './operation-helpers.ts';

export type SharedScheduleRestFields = {
  readonly cronExpression: unknown;
  readonly every: unknown;
  readonly description: unknown;
  readonly overlap: unknown;
  readonly backfill: unknown;
  readonly jitter: unknown;
};

function isJsonObjectLikeRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export async function parseScheduleRestBodyRequestRecord(
  request: Request,
  context?: RestInputContext,
): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await readRestJsonBody(request, context);
  } catch (error) {
    if (isOperationFault(error)) throw error;
    throw invalidParamsFault('Invalid JSON body');
  }

  if (!isJsonObjectLikeRecord(body)) {
    throw invalidParamsFault('Request body must be a JSON object');
  }

  return body;
}

export function extractSharedScheduleRestFields(
  record: Record<string, unknown>,
): SharedScheduleRestFields {
  // Read cadence fields by own property: arrays inherit `every` from
  // Array.prototype, and a direct read would masquerade as an interval spec.
  return {
    cronExpression: Object.hasOwn(record, 'cronExpression') ? record['cronExpression'] : undefined,
    every: Object.hasOwn(record, 'every') ? record['every'] : undefined,
    description: record['description'],
    overlap: record['overlap'],
    backfill: record['backfill'],
    jitter: record['jitter'],
  };
}
