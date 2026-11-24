/**
 * The JSON Schema of the `data:` line of a Server-Sent Events `event: error` frame, as the AsyncAPI
 * document describes it.
 *
 * @module sse-error-payload-schema
 */

import { MAX_REMEDIATION_LENGTH } from './fault-remediation.ts';

/**
 * The error frame a stream that fails after it started writes: the fault's `code`, `message` and
 * allowlisted `data`, with `retryable` always and `remediation` when the fault carries one, as the
 * REST, JSON-RPC and MCP projections do.
 */
export function sseErrorPayloadSchema(): Record<string, unknown> {
  return {
    properties: {
      code: { type: 'string' },
      data: {},
      message: { type: 'string' },
      remediation: {
        type: 'string',
        minLength: 1,
        maxLength: MAX_REMEDIATION_LENGTH,
        description: 'One line of plain text saying what to do next; omitted when none is known',
      },
      retryable: {
        type: 'boolean',
        description: 'Whether repeating the identical call later can succeed',
      },
    },
    required: ['message', 'retryable'],
    type: 'object',
  };
}
