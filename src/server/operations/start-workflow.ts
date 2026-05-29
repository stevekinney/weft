import { z } from 'zod';

import {
  WorkflowAlreadyExistsError,
  WorkflowNotRegisteredError,
} from '../../core/engine/errors.ts';
import { runtimeWorkflowEngine } from '../../core/runtime-workflow-engine.ts';
import { validateAttributeType } from '../../core/search-attributes.ts';
import {
  assertExclusiveStartWorkflowOptions,
  coerceStartWorkflowDuration,
  coerceStartWorkflowId,
  coerceStartWorkflowTags,
  coerceStartWorkflowTimestamp,
  StartWorkflowValidationError,
} from '../../core/start-workflow-validation.ts';
import type {
  SearchAttributeSchema,
  SearchAttributeValue,
  StartOptions,
} from '../../core/types.ts';
import type { OperationFault } from '../operation-fault.ts';
import { defineOperation } from '../operation-registry.ts';
import type { UnknownRestBinding } from '../rest-bindings.ts';
import { invalidParamsFault, shapeRestFault } from './operation-helpers.ts';

// Inputs are intentionally permissive at the schema boundary so REST
// callers (and equivalent JSON-RPC callers) hit the same validation in
// `invoke()` rather than being rejected by Zod with a different error path.
// All field validation lives in `invoke()` to keep one cross-transport contract.
const startWorkflowInput = z.object({
  type: z.unknown().describe('Workflow type name. Runtime validation requires a non-empty string.'),
  input: z.unknown().optional(),
  id: z.unknown().optional(),
  executionTimeout: z.unknown().optional(),
  startAt: z.unknown().optional(),
  startAfter: z.unknown().optional(),
  tags: z.unknown().optional(),
  idempotencyKey: z.unknown().optional(),
  searchAttributes: z.unknown().optional(),
});

const startWorkflowOutput = z.object({
  id: z.string(),
});

export type StartWorkflowInput = z.infer<typeof startWorkflowInput>;
export type StartWorkflowOutput = z.infer<typeof startWorkflowOutput>;

/**
 * Validate the `type` field and build `StartOptions` from the operation input.
 *
 * Validates `type` first so both REST and JSON-RPC clients share one error path.
 * Remaining fields are validated inside `buildStartWorkflowOptions` in the order
 * they appear there: id → executionTimeout → startAt → startAfter → tags →
 * idempotencyKey → searchAttributes.
 *
 * `lookupSearchAttributeSchema` is invoked only after the type has been
 * validated, so an invalid type rejects without touching engine state.
 *
 * Returns the workflow type string and the resolved `StartOptions`.
 */
function validateStartWorkflowInput(
  input: StartWorkflowInput,
  lookupSearchAttributeSchema: (type: string) => SearchAttributeSchema | undefined,
): { type: string; options: StartOptions } {
  if (typeof input.type !== 'string' || input.type.length === 0) {
    throw invalidParamsFault('Missing required field: type');
  }
  const type = input.type;

  let options: StartOptions;
  try {
    options = buildStartWorkflowOptions(input, lookupSearchAttributeSchema(type));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw invalidParamsFault(message);
  }

  return { type, options };
}

/**
 * Map an engine error thrown by `engine.start` to the canonical operation fault.
 *
 * Routing order (typed errors take precedence over string matching):
 *   1. WorkflowNotRegisteredError   → InvalidParams
 *   2. WorkflowAlreadyExistsError   → Conflict
 *   3. StartWorkflowValidationError → InvalidParams
 *   4. otherwise                    → EngineFailure
 */
function resolveStartWorkflowAccess(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);

  if (error instanceof WorkflowNotRegisteredError) {
    throw invalidParamsFault(message);
  }
  if (error instanceof WorkflowAlreadyExistsError) {
    const fault: OperationFault = {
      code: 'Conflict',
      message,
      data: { reason: message },
    };
    throw fault;
  }
  if (error instanceof StartWorkflowValidationError) {
    throw invalidParamsFault(message);
  }

  const fault: OperationFault = {
    code: 'EngineFailure',
    message,
    data: {},
  };
  throw fault;
}

export const startWorkflowOperation = defineOperation<StartWorkflowInput, StartWorkflowOutput>({
  name: 'weft.workflows.start',
  mcpExposable: false,
  summary: 'Start a new workflow',
  description:
    'Start a new workflow execution of a registered type. Requires `type` (the registered ' +
    'workflow type name) and accepts an optional `input` payload plus start options: `id` ' +
    '(client-supplied workflow id), `executionTimeout`, `startAt`/`startAfter` (mutually ' +
    'exclusive scheduling), `tags`, and `searchAttributes`. Returns the workflow `id`. Faults ' +
    'with InvalidParams for an unregistered type or malformed options, and Conflict when a ' +
    'workflow with the same id already exists.',
  destructive: false,
  tags: ['Workflows'],
  inputSchema: startWorkflowInput,
  outputSchema: startWorkflowOutput,
  access: { kind: 'public' },
  producibleFaults: ['Conflict'],
  transports: { http: true, jsonRpcHttp: true, jsonRpcWebSocket: true, jsonRpcStdio: true },
  unknownKeyPolicy: { http: 'strip', jsonRpc: 'reject' },
  invoke: async ({ input, engine }): Promise<StartWorkflowOutput> => {
    const typedEngine = runtimeWorkflowEngine(engine);

    // The validator checks `input.type` first and only then calls the
    // schema-lookup callback, so an invalid type rejects without invoking
    // engine logic on an empty string.
    const { type, options } = validateStartWorkflowInput(input, (validType) => {
      return typedEngine.getWorkflowDefinition(validType)?.searchAttributes;
    });

    try {
      const handle = await typedEngine.start(type, input.input, options);
      return { id: handle.id };
    } catch (error) {
      // Typed engine errors first; the engine throws these for the
      // canonical failure modes (workflow type not registered, workflow
      // ID collision). String-matching the message would silently
      // misclassify the fault if the message text is ever changed.
      resolveStartWorkflowAccess(error);
    }
  },
});

function buildStartWorkflowOptions(
  input: StartWorkflowInput,
  searchAttributeSchema: SearchAttributeSchema | undefined,
): StartOptions {
  const options: StartOptions = {};

  if (input.id !== undefined) {
    options.id = coerceStartWorkflowId(input.id, 'Field "id"');
  }
  if (input.executionTimeout !== undefined) {
    options.executionTimeout = coerceStartWorkflowDuration(
      input.executionTimeout,
      'Field "executionTimeout"',
    );
  }
  if (input.startAt !== undefined) {
    options.startAt = coerceStartWorkflowTimestamp(input.startAt, 'Field "startAt"');
  }
  if (input.startAfter !== undefined) {
    options.startAfter = coerceStartWorkflowDuration(input.startAfter, 'Field "startAfter"');
  }
  if (input.tags !== undefined) {
    options.tags = coerceStartWorkflowTags(input.tags, 'Field "tags"');
  }
  if (input.idempotencyKey !== undefined) {
    throw new StartWorkflowValidationError(
      'idempotencyKey is not supported over HttpClient because the start workflow HTTP protocol does not implement start idempotency',
    );
  }
  if (input.searchAttributes !== undefined) {
    options.searchAttributes = coerceStartWorkflowSearchAttributes(
      input.searchAttributes,
      'Field "searchAttributes"',
      searchAttributeSchema,
    );
  }

  assertExclusiveStartWorkflowOptions(options.startAt, options.startAfter);

  return options;
}

function coerceStartWorkflowSearchAttributes(
  value: unknown,
  fieldName: string,
  schema: SearchAttributeSchema | undefined,
): Record<string, SearchAttributeValue> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new StartWorkflowValidationError(`${fieldName} must be an object`);
  }

  // Null-prototype record keeps untrusted attribute keys from touching Object.prototype setters.
  const attributes = Object.create(null) as Record<string, SearchAttributeValue>;
  for (const [key, attributeValue] of Object.entries(value)) {
    const coercedValue = coerceStartWorkflowSearchAttributeValue(
      key,
      attributeValue,
      fieldName,
      schema,
    );
    attributes[key] = coercedValue;
  }

  return attributes;
}

function coerceStartWorkflowSearchAttributeValue(
  key: string,
  value: unknown,
  fieldName: string,
  schema: SearchAttributeSchema | undefined,
): SearchAttributeValue {
  if (!isSearchAttributeValue(value)) {
    throw new StartWorkflowValidationError(
      `${fieldName}.${key} must be a string, number, boolean, Date, or string array`,
    );
  }

  if (schema === undefined) {
    return value;
  }

  const definition = schema[key];
  if (definition === undefined) {
    throw new StartWorkflowValidationError(
      `Unknown search attribute "${key}". Registered attributes: ${Object.keys(schema).join(', ')}`,
    );
  }

  const normalizedValue =
    definition.type === 'string' && definition.format === 'date-time' && typeof value === 'string'
      ? coerceDateTimeSearchAttribute(key, value, fieldName)
      : value;

  try {
    validateAttributeType(key, normalizedValue, definition);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new StartWorkflowValidationError(message);
  }

  return normalizedValue;
}

function coerceDateTimeSearchAttribute(key: string, value: string, fieldName: string): Date {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new StartWorkflowValidationError(`${fieldName}.${key} must be a valid date-time string`);
  }
  return date;
}

function isSearchAttributeValue(value: unknown): value is SearchAttributeValue {
  return (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    value instanceof Date ||
    (Array.isArray(value) && value.every((item) => typeof item === 'string'))
  );
}

export const startWorkflowRestBinding: UnknownRestBinding = {
  method: 'POST',
  path: '/v1/workflows',
  pathParamNames: [],
  operationName: 'weft.workflows.start',
  inputSources: {
    type: { kind: 'body-field', bodyField: 'type' },
    input: { kind: 'body-field', bodyField: 'input' },
    id: { kind: 'body-field', bodyField: 'id' },
    executionTimeout: { kind: 'body-field', bodyField: 'executionTimeout' },
    startAt: { kind: 'body-field', bodyField: 'startAt' },
    startAfter: { kind: 'body-field', bodyField: 'startAfter' },
    tags: { kind: 'body-field', bodyField: 'tags' },
    idempotencyKey: { kind: 'body-field', bodyField: 'idempotencyKey' },
    searchAttributes: { kind: 'body-field', bodyField: 'searchAttributes' },
  },
  extractInput: async (request) => {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      throw invalidParamsFault('Invalid JSON body');
    }

    // arrays are typeof 'object', so they pass this guard and
    // fall through to the "Missing required field: type" check in `invoke`
    // (the single cross-transport validator).
    if (typeof body !== 'object' || body === null) {
      throw invalidParamsFault('Request body must be a JSON object');
    }

    const record = body as Record<string, unknown>;
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
  },
  success: { kind: 'json', status: 201 },
  shapeFault: shapeRestFault,
};
