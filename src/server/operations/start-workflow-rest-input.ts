import { invalidParamsFault } from './operation-helpers.ts';

export type SharedStartWorkflowRestInput = {
  type: unknown;
  input: unknown;
  id: unknown;
  executionTimeout: unknown;
  startAt: unknown;
  startAfter: unknown;
  tags: unknown;
  idempotencyKey: unknown;
  searchAttributes: unknown;
};

export async function readStartWorkflowRestBodyRecord(
  request: Request,
): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw invalidParamsFault('Invalid JSON body');
  }

  if (typeof body !== 'object' || body === null) {
    throw invalidParamsFault('Request body must be a JSON object');
  }

  return body as Record<string, unknown>;
}

export async function extractSharedStartWorkflowRestInput(
  request: Request,
): Promise<SharedStartWorkflowRestInput> {
  return pickSharedStartWorkflowRestInput(await readStartWorkflowRestBodyRecord(request));
}

export function pickSharedStartWorkflowRestInput(
  record: Record<string, unknown>,
): SharedStartWorkflowRestInput {
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
