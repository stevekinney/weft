import { z } from 'zod';

import {
  IdempotencyKeyPurgedError,
  WorkflowAlreadyExistsError,
  WorkflowNotRegisteredError,
} from '../../core/engine/errors.ts';
import { runtimeWorkflowEngine } from '../../core/runtime-workflow-engine.ts';
import { StartWorkflowValidationError } from '../../core/start-workflow-validation.ts';
import type { SearchAttributeSchema, StartOptions } from '../../core/types.ts';
import type { OperationFault } from '../operation-fault.ts';
import { defineOperation } from '../operation-registry.ts';
import type { UnknownRestBinding } from '../rest-bindings.ts';
import { invalidParamsFault, shapeRestFault } from './operation-helpers.ts';
import { buildSharedStartWorkflowOptions } from './start-workflow-options.ts';
import {
  extractSharedStartWorkflowRestFields,
  parseStartWorkflowRequestRecord,
} from './start-workflow-rest-input.ts';

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
    options = buildSharedStartWorkflowOptions(input, lookupSearchAttributeSchema(type));
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
 *   3. IdempotencyKeyPurgedError    → Conflict (key maps to a purged run)
 *   4. StartWorkflowValidationError → InvalidParams
 *   5. otherwise                    → EngineFailure
 */
function resolveStartWorkflowAccess(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);

  if (error instanceof WorkflowNotRegisteredError) {
    throw invalidParamsFault(message, error.code);
  }
  if (error instanceof WorkflowAlreadyExistsError || error instanceof IdempotencyKeyPurgedError) {
    // An id collision or a spent idempotency key (its run purged) are both
    // client-actionable conflicts: pick a different id / key. Surface as Conflict
    // (409) rather than letting the purged-key case mask to an opaque 500.
    // `weftCode` recovers which of the two collapsed typed errors this was.
    const fault: OperationFault = {
      code: 'Conflict',
      message,
      data: { reason: message, weftCode: error.code },
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
    'exclusive scheduling), `tags`, `idempotencyKey` (at-most-once dedup: a repeated key ' +
    'returns the existing run instead of starting a second), and `searchAttributes`. Returns ' +
    'the workflow `id`. Faults with InvalidParams for an unregistered type or malformed ' +
    'options, and Conflict when a workflow with the same id already exists or the supplied ' +
    '`idempotencyKey` has been spent (its run was purged or swept by retention).',
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
    return extractSharedStartWorkflowRestFields(await parseStartWorkflowRequestRecord(request));
  },
  success: { kind: 'json', status: 201 },
  shapeFault: shapeRestFault,
};
