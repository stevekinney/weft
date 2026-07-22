/**
 * OpenAPI response helpers for catalogued operation faults.
 *
 * @module server/openapi-error-responses
 */

import type { FaultCode } from '../core/fault-code.ts';
import type { ErasedOperation } from './operation-catalog.ts';
import { UNIVERSAL_FAULT_DEFAULTS } from './operation-catalog/raise-fault.ts';
import { FAULT_CODE_TO_HTTP_STATUS } from './operation-fault.ts';

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
