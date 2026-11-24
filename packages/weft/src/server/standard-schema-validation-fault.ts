import type { OperationFault } from "../embedded/backchannel/src/index.ts";
import { StandardSchemaValidationError } from '../core/types/standard-schema-validate.ts';

/**
 * The `InvalidParams` fault for a payload the engine rejected against its
 * declared schema (`payloadValidation: 'inbound'`), or `undefined` for any
 * other error. Each issue's path starts with the request field the payload
 * arrived in, followed by the JSON Pointer segments of the offending value.
 */
export function standardSchemaValidationFault(error: unknown): OperationFault | undefined {
  if (!(error instanceof StandardSchemaValidationError)) return undefined;
  return {
    code: 'InvalidParams',
    message: error.message,
    data: {
      issues: error.issues.map((issue) => ({
        path: [error.fieldName, ...jsonPointerSegments(issue.path)],
        message: issue.message,
        code: 'custom',
      })),
      weftCode: error.code,
    },
  };
}

function jsonPointerSegments(pointer: string): string[] {
  if (pointer === '') return [];
  return pointer
    .slice(1)
    .split('/')
    .map((segment) => segment.replaceAll('~1', '/').replaceAll('~0', '~'));
}
