import { z } from 'zod';

import {
  StartOrSignalConflictError,
  WorkflowNotRegisteredError,
} from '../../core/engine/errors.ts';
import { runtimeWorkflowEngine } from '../../core/runtime-workflow-engine.ts';
import { isSignalIdWithinByteLimit } from '../../core/signal-id.ts';
import {
  assertExclusiveStartWorkflowOptions,
  coerceStartWorkflowDuration,
  coerceStartWorkflowId,
  coerceStartWorkflowIdempotencyKey,
  coerceStartWorkflowTags,
  coerceStartWorkflowTimestamp,
  StartWorkflowValidationError,
} from '../../core/start-workflow-validation.ts';
import type { SearchAttributeSchema, StartOptions, StartOrSignalSignal } from '../../core/types.ts';
import type { OperationFault } from '../operation-fault.ts';
import { defineOperation } from '../operation-registry.ts';
import type { UnknownRestBinding } from '../rest-bindings.ts';
import { invalidParamsFault, shapeRestFault } from './operation-helpers.ts';
import { coerceStartWorkflowSearchAttributes } from './start-workflow-search-attributes.ts';

// Permissive at the schema boundary so all field validation lives in `invoke()`,
// giving one cross-transport contract (mirrors weft.workflows.start).
const startOrSignalWorkflowInput = z.object({
  type: z.unknown().describe('Workflow type name. Runtime validation requires a non-empty string.'),
  input: z.unknown().optional(),
  signalName: z.unknown().describe('Signal name. Runtime validation requires a non-empty string.'),
  signalPayload: z.unknown().optional(),
  signalId: z
    .string()
    .min(1)
    .refine(isSignalIdWithinByteLimit, 'signalId must be at most 128 bytes')
    .optional(),
  id: z.unknown().optional(),
  executionTimeout: z.unknown().optional(),
  startAt: z.unknown().optional(),
  startAfter: z.unknown().optional(),
  tags: z.unknown().optional(),
  idempotencyKey: z.unknown().optional(),
  searchAttributes: z.unknown().optional(),
});

const startOrSignalWorkflowOutput = z.object({
  id: z.string(),
});

export type StartOrSignalWorkflowInput = z.infer<typeof startOrSignalWorkflowInput>;
export type StartOrSignalWorkflowOutput = z.infer<typeof startOrSignalWorkflowOutput>;

/**
 * Validate the input and build the `(type, signal, options)` triple for
 * `engine.startOrSignal`. Validates `type` and `signalName` first so both REST
 * and JSON-RPC clients share one error path, then builds `StartOptions` in the
 * same field order as `weft.workflows.start`.
 */
function validateStartOrSignalWorkflowInput(
  input: StartOrSignalWorkflowInput,
  lookupSearchAttributeSchema: (type: string) => SearchAttributeSchema | undefined,
): {
  type: string;
  signal: StartOrSignalSignal;
  options: StartOptions;
} {
  if (typeof input.type !== 'string' || input.type.length === 0) {
    throw invalidParamsFault('Missing required field: type');
  }
  if (typeof input.signalName !== 'string' || input.signalName.length === 0) {
    throw invalidParamsFault('Missing required field: signalName');
  }

  let options: StartOptions;
  try {
    options = buildStartOrSignalOptions(input, lookupSearchAttributeSchema(input.type));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw invalidParamsFault(message);
  }

  assertConvergenceTokenProvided(input.signalId, options.idempotencyKey);

  const signal: StartOrSignalSignal = {
    name: input.signalName,
    payload: input.signalPayload,
    ...(input.signalId === undefined ? {} : { signalId: input.signalId }),
  };

  return { type: input.type, signal, options };
}

/**
 * Exactly one of `signalId` / `idempotencyKey` must be present so concurrent
 * callers converge on a single delivered signal — neither (no convergence token)
 * nor both (the key-derived id and a caller id would diverge) is allowed.
 */
function assertConvergenceTokenProvided(
  signalId: string | undefined,
  idempotencyKey: string | undefined,
): void {
  if (signalId === undefined && idempotencyKey === undefined) {
    throw invalidParamsFault(
      'startOrSignal requires either signalId or idempotencyKey so concurrent callers converge ' +
        'on a single delivered signal.',
    );
  }
  if (signalId !== undefined && idempotencyKey !== undefined) {
    throw invalidParamsFault(
      'startOrSignal does not accept both signalId and idempotencyKey: the signal id derives ' +
        'from the idempotency key for convergence. Provide exactly one.',
    );
  }
}

function buildStartOrSignalOptions(
  input: StartOrSignalWorkflowInput,
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
    options.idempotencyKey = coerceStartWorkflowIdempotencyKey(
      input.idempotencyKey,
      'Field "idempotencyKey"',
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

/**
 * Map an engine error thrown by `engine.startOrSignal` to the canonical fault.
 *
 * Routing order (typed errors take precedence over string matching):
 *   1. WorkflowNotRegisteredError   → InvalidParams
 *   2. StartOrSignalConflictError   → Conflict (target already terminal)
 *   3. StartWorkflowValidationError → InvalidParams
 *   4. otherwise                    → EngineFailure
 */
function resolveStartOrSignalWorkflowFault(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);

  if (error instanceof WorkflowNotRegisteredError) {
    throw invalidParamsFault(message);
  }
  if (error instanceof StartOrSignalConflictError) {
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

export const startOrSignalWorkflowOperation = defineOperation<
  StartOrSignalWorkflowInput,
  StartOrSignalWorkflowOutput
>({
  name: 'weft.workflows.startorsignal',
  mcpExposable: false,
  summary: 'Atomically start a workflow or signal it if it already exists',
  description:
    'Start a workflow or deliver a signal to it if it already exists (signal-with-start). An ' +
    'absent target is created and delivered the signal in one batch; a non-terminal target ' +
    '(running, pending, or suspended) is signalled; a terminal target faults with Conflict. ' +
    'Requires `type`, `signalName`, and either `signalId` or `idempotencyKey` for convergence ' +
    '(not both). Accepts `input`, `signalPayload`, and the same start options as ' +
    'weft.workflows.start (`id`, `executionTimeout`, `startAt`/`startAfter`, `tags`, ' +
    '`idempotencyKey`, `searchAttributes`). Returns the workflow `id`. Concurrent same-key ' +
    'callers converge on one workflow and one signal.',
  destructive: false,
  tags: ['Workflows', 'Signals'],
  inputSchema: startOrSignalWorkflowInput,
  outputSchema: startOrSignalWorkflowOutput,
  access: { kind: 'public' },
  producibleFaults: ['Conflict'],
  transports: { http: true, jsonRpcHttp: true, jsonRpcWebSocket: true, jsonRpcStdio: true },
  unknownKeyPolicy: { http: 'strip', jsonRpc: 'reject' },
  invoke: async ({ input, engine }): Promise<StartOrSignalWorkflowOutput> => {
    const typedEngine = runtimeWorkflowEngine(engine);
    const { type, signal, options } = validateStartOrSignalWorkflowInput(input, (validType) => {
      return typedEngine.getWorkflowDefinition(validType)?.searchAttributes;
    });

    try {
      const handle = await typedEngine.startOrSignal(type, input.input, signal, options);
      return { id: handle.id };
    } catch (error) {
      resolveStartOrSignalWorkflowFault(error);
    }
  },
});

export const startOrSignalWorkflowRestBinding: UnknownRestBinding = {
  method: 'POST',
  path: '/v1/workflows/start-or-signal',
  pathParamNames: [],
  operationName: 'weft.workflows.startorsignal',
  inputSources: {
    type: { kind: 'body-field', bodyField: 'type' },
    input: { kind: 'body-field', bodyField: 'input' },
    signalName: { kind: 'body-field', bodyField: 'signalName' },
    signalPayload: { kind: 'body-field', bodyField: 'signalPayload' },
    signalId: { kind: 'body-field', bodyField: 'signalId' },
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
    if (typeof body !== 'object' || body === null) {
      throw invalidParamsFault('Request body must be a JSON object');
    }

    const record = body as Record<string, unknown>;
    return {
      type: record['type'],
      input: record['input'],
      signalName: record['signalName'],
      signalPayload: record['signalPayload'],
      signalId: record['signalId'],
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
