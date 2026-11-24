/**
 * OpenAPI response helpers for catalogued operation faults.
 *
 * @module server/openapi-error-responses
 */

import { MAX_REMEDIATION_LENGTH } from './fault-remediation.ts';
import type { ErasedOperation } from './operation-catalog.ts';
import { UNIVERSAL_FAULT_DEFAULTS } from './operation-catalog/universal-faults.ts';
import { FAULT_CODE_TO_HTTP_STATUS, type OperationFault } from './operation-fault.ts';

type FaultCode = OperationFault['code'];

/**
 * Shared JSON error schema emitted as `#/components/schemas/Error`.
 */
export const ERROR_SCHEMA: Record<string, unknown> = {
  type: 'object',
  required: ['error'],
  additionalProperties: false,
  properties: {
    error: { type: 'string', description: 'Human-readable error description' },
    weftCode: {
      type: 'string',
      description: 'Fine-grained public Weft error code when one is available',
    },
    retryable: {
      type: 'boolean',
      description:
        'Whether repeating the identical call later can succeed; present on every operation fault',
    },
    remediation: {
      type: 'string',
      minLength: 1,
      maxLength: MAX_REMEDIATION_LENGTH,
      description: 'One line of plain text saying what to do next; omitted when none is known',
    },
    data: {
      type: 'object',
      description: 'Audited fault-specific context; omitted when no fields are safe to expose',
      additionalProperties: false,
      properties: {
        resource: { type: 'string' },
        identifier: { type: 'string' },
        missingTypes: { type: 'array', items: { type: 'string' } },
        missingWorkflowCount: { type: 'integer', minimum: 0 },
        samplesTruncated: { type: 'boolean' },
        maxBytes: { type: 'integer', minimum: 0 },
        operationName: { type: 'string' },
        updateId: { type: 'string' },
        transport: { type: 'string' },
        supported: { type: 'array', items: { type: 'string' } },
        droppedCount: { type: 'integer', minimum: 0 },
        issues: {
          type: 'array',
          items: {
            type: 'object',
            required: ['path', 'message', 'code'],
            additionalProperties: false,
            properties: {
              path: {
                type: 'array',
                items: { oneOf: [{ type: 'string' }, { type: 'number' }] },
              },
              message: { type: 'string' },
              code: { type: 'string' },
            },
          },
        },
        method: { type: 'string' },
        expectedRevision: { oneOf: [{ type: 'string' }, { type: 'number' }] },
        currentRevision: { oneOf: [{ type: 'string' }, { type: 'number' }] },
        retryAfterSeconds: { type: 'number', minimum: 0 },
        capability: { type: 'string' },
      },
    },
  },
};

/**
 * Build OpenAPI error responses for an operation's declared producible faults
 * plus the universal pipeline fault defaults.
 */
export function buildErrorResponses(operation: ErasedOperation): Record<string, unknown> {
  const codes: Set<FaultCode> = new Set([
    ...UNIVERSAL_FAULT_DEFAULTS,
    ...(operation.producibleFaults ?? []),
  ]);

  const codesByStatus = new Map<string, FaultCode[]>();
  for (const code of codes) {
    const status = String(FAULT_CODE_TO_HTTP_STATUS[code]);
    const existingCodes = codesByStatus.get(status);
    if (existingCodes === undefined) {
      codesByStatus.set(status, [code]);
      continue;
    }
    existingCodes.push(code);
  }

  const responses: Record<string, unknown> = {};
  for (const [status, statusCodes] of [...codesByStatus.entries()].toSorted(
    ([left], [right]) => Number(left) - Number(right),
  )) {
    responses[status] = {
      description: statusCodes.toSorted().join(', '),
      content: {
        'application/json': {
          schema: { $ref: '#/components/schemas/Error' },
        },
      },
    };
  }
  return responses;
}
