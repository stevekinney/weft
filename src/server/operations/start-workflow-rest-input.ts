import { invalidParamsFault } from './operation-helpers.ts';

export type SharedStartWorkflowRestFields = {
  readonly type: unknown;
  readonly input: unknown;
  readonly id: unknown;
  readonly executionTimeout: unknown;
  readonly startAt: unknown;
  readonly startAfter: unknown;
  readonly tags: unknown;
  readonly idempotencyKey: unknown;
  readonly searchAttributes: unknown;
};

function isJsonObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export async function parseJsonObjectRequestBody(
  request: Request,
): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw invalidParamsFault('Invalid JSON body');
  }

  // Arrays are typeof 'object', so they pass this guard and fall through to the
  // operation validator. That preserves the current cross-transport error path.
  if (body === null || typeof body !== 'object') {
    throw invalidParamsFault('Request body must be a JSON object');
  }

  return isJsonObjectRecord(body) ? body : Object.fromEntries(Object.entries(body));
}

export function extractSharedStartWorkflowRestFields(
  record: Record<string, unknown>,
): SharedStartWorkflowRestFields {
  return {
    type: record['type'],
    input: record['input'],
    id: record['id'],
    executionTimeout: record['executionTimeout'],
    startAt: record['startAt'],
    startAfter: record['startAfter'],
    tags: record['tags'],
    idempotencyKey: record['idempotencyKey'],
    searchAttributes: record['searchAttributes'],
  };
}
