import { z } from 'zod';

import type {
  BulkOperationCommitOptions,
  BulkOperationDryRunOptions,
  BulkOperationPrincipal,
} from '../../core/types.ts';
import {
  MAX_BULK_CONFIRMATION_TOKEN_LENGTH,
  MAX_BULK_OPERATION_REQUEST_ID_LENGTH,
} from '../../core/types/bulk.ts';
import type { AccessPolicy } from '../authorization.ts';
import type { Principal } from '../principal.ts';
import { invalidParamsFault } from './operation-helpers.ts';

export const bulkOperationControlInputSchema = z.object({
  dryRun: z.boolean().optional(),
  confirmationToken: z.string().min(1).max(MAX_BULK_CONFIRMATION_TOKEN_LENGTH).optional(),
  requestId: z.string().min(1).max(MAX_BULK_OPERATION_REQUEST_ID_LENGTH).optional(),
  bulkConcurrency: z.number().int().min(1).optional(),
});

export type BulkOperationControlInput = z.infer<typeof bulkOperationControlInputSchema>;

export const bulkOperatorAccessPolicy = {
  kind: 'scoped',
  scopes: { kind: 'anyOf', scopes: ['workflows:admin'] },
} satisfies AccessPolicy;

export function parseBulkOperationControlFromBody(body: unknown): BulkOperationControlInput {
  if (body === undefined) {
    return {};
  }

  const record = parseJsonObjectBody(body);
  const dryRun = parseOptionalBooleanControl(record, 'dryRun');
  const confirmationToken = parseOptionalNonEmptyStringControl(record, 'confirmationToken');
  const requestId = parseOptionalBulkRequestId(record);
  const bulkConcurrency = parseOptionalPositiveIntegerControl(record, 'bulkConcurrency');

  return {
    ...(dryRun === undefined ? {} : { dryRun }),
    ...(confirmationToken === undefined ? {} : { confirmationToken }),
    ...(requestId === undefined ? {} : { requestId }),
    ...(bulkConcurrency === undefined ? {} : { bulkConcurrency }),
  };
}

export function bulkOperationOptionsFromInput(
  input: BulkOperationControlInput,
  principal: Principal,
): BulkOperationDryRunOptions | BulkOperationCommitOptions {
  const auditPrincipal = principalToBulkOperationPrincipal(principal);
  if (input.dryRun === true) {
    return {
      dryRun: true,
      principal: auditPrincipal,
      ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
      ...(input.bulkConcurrency === undefined ? {} : { bulkConcurrency: input.bulkConcurrency }),
    };
  }

  if (input.confirmationToken === undefined) {
    throw invalidParamsFault('Field "confirmationToken" is required after a dry run');
  }

  return {
    confirmationToken: input.confirmationToken,
    principal: auditPrincipal,
    ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
    ...(input.bulkConcurrency === undefined ? {} : { bulkConcurrency: input.bulkConcurrency }),
  };
}

function principalToBulkOperationPrincipal(principal: Principal): BulkOperationPrincipal {
  if (principal.method === 'unauthenticated') {
    return { method: 'unauthenticated' };
  }

  return {
    method: principal.method,
    ...(principal.subject === undefined ? {} : { subject: principal.subject }),
  };
}

function parseJsonObjectBody(body: unknown): object {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new Error('Request body must be a JSON object');
  }

  return body;
}

function parseOptionalBooleanControl(record: object, fieldName: 'dryRun'): boolean | undefined {
  const value: unknown = Reflect.get(record, fieldName);
  if (value === undefined) return undefined;
  if (typeof value === 'boolean') return value;
  throw new Error(`Field "${fieldName}" must be a boolean`);
}

function parseOptionalPositiveIntegerControl(
  record: object,
  fieldName: 'bulkConcurrency',
): number | undefined {
  const value: unknown = Reflect.get(record, fieldName);
  if (value === undefined) return undefined;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 1) return value;
  throw new Error(`Field "${fieldName}" must be a positive integer`);
}

function parseOptionalNonEmptyStringControl(
  record: object,
  fieldName: 'confirmationToken' | 'requestId',
): string | undefined {
  const value: unknown = Reflect.get(record, fieldName);
  if (value === undefined) return undefined;
  if (typeof value === 'string' && value.length > 0) return value;
  throw new Error(`Field "${fieldName}" must be a non-empty string`);
}

function parseOptionalBulkRequestId(record: object): string | undefined {
  const requestId = parseOptionalNonEmptyStringControl(record, 'requestId');
  if (requestId === undefined) return undefined;
  if (requestId.length <= MAX_BULK_OPERATION_REQUEST_ID_LENGTH) return requestId;

  throw new Error(
    `Field "requestId" must be at most ${MAX_BULK_OPERATION_REQUEST_ID_LENGTH} characters`,
  );
}
