import { z } from 'zod';

import {
  IdempotencyKeyPurgedError,
  StartOrSignalConflictError,
  WorkflowNotRegisteredError,
} from '../../core/engine/errors.ts';
import { runtimeWorkflowEngine } from '../../core/runtime-workflow-engine.ts';
import { isSignalIdWithinByteLimit } from '../../core/signal-id.ts';
import { StartWorkflowValidationError } from '../../core/start-workflow-validation.ts';
import type { SearchAttributeSchema, StartOptions, StartOrSignalSignal } from '../../core/types.ts';
import type { OperationFault } from '../operation-fault.ts';
import { defineOperation } from '../operation-registry.ts';
import type { UnknownRestBinding } from '../rest-bindings.ts';
import { invalidParamsFault, shapeRestFault } from './operation-helpers.ts';
import { buildSharedStartWorkflowOptions } from './start-workflow-options.ts';
import {
  extractSharedStartWorkflowRestFields,
  parseStartWorkflowRequestRecord,
} from './start-workflow-rest-input.ts';

// Permissive at the schema boundary so all field validation lives in `invoke()`,
// giving one cross-transport contract (mirrors weft.workflows.start).
const startOrSignalWorkflowInput = z.object({
  type: z.unknown().describe('Workflow type name. Runtime validation requires a non-empty string.'),
  input: z.unknown().optional(),
  signalName: z.string().min(1).describe('Signal name. Must be a non-empty string.'),
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
  // Which atomic path the call took (#466): `'started'` created the run,
  // `'signalled'` delivered to a run that already existed.
  outcome: z.enum(['started', 'signalled']),
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
  // `signalName` is `z.string().min(1)` — Zod rejects an absent or empty value
  // at the schema boundary before `invoke`, so no manual guard is needed here.

  let options: StartOptions;
  try {
    options = buildSharedStartWorkflowOptions(input, lookupSearchAttributeSchema(input.type));
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
 * Exactly one of `signalId` / `idempotencyKey` must be present to identify the
 * signal to deliver — neither (no signal id to derive or use) nor both (the
 * key-derived id and a caller-supplied id would diverge) is allowed. Convergence
 * of concurrent callers additionally requires a shared workflow identity (a shared
 * `idempotencyKey`, or a shared `id` plus `signalId`); a bare `signalId` satisfies
 * this rule but does not converge.
 */
function assertConvergenceTokenProvided(
  signalId: string | undefined,
  idempotencyKey: string | undefined,
): void {
  if (signalId === undefined && idempotencyKey === undefined) {
    throw invalidParamsFault(
      'startOrSignal requires either signalId or idempotencyKey to identify the signal to ' +
        'deliver. (Concurrent callers converge on one workflow and one signal only with a shared ' +
        'idempotencyKey, or a shared id plus signalId; a bare signalId starts a fresh run per ' +
        'caller.)',
    );
  }
  if (signalId !== undefined && idempotencyKey !== undefined) {
    throw invalidParamsFault(
      'startOrSignal does not accept both signalId and idempotencyKey: the signal id derives ' +
        'from the idempotency key for convergence. Provide exactly one.',
    );
  }
}

/**
 * Map an engine error thrown by `engine.startOrSignal` to the canonical fault.
 *
 * Routing order (typed errors take precedence over string matching):
 *   1. WorkflowNotRegisteredError   → InvalidParams
 *   2. StartOrSignalConflictError   → Conflict (target already terminal)
 *   3. IdempotencyKeyPurgedError    → Conflict (key maps to a purged run)
 *   4. StartWorkflowValidationError → InvalidParams
 *   5. otherwise                    → EngineFailure
 */
function resolveStartOrSignalWorkflowFault(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);

  if (error instanceof WorkflowNotRegisteredError) {
    throw invalidParamsFault(message, error.code);
  }
  if (error instanceof StartOrSignalConflictError || error instanceof IdempotencyKeyPurgedError) {
    // Both are client-actionable convergence conflicts: a terminal target, or a
    // spent key whose run was purged. Surface as Conflict (409) so the caller can
    // choose a different id / idempotency key — not an opaque masked 500.
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
    '(running, pending, or suspended) is signalled; a terminal target faults with Conflict, as ' +
    'does a spent `idempotencyKey` whose run was purged or swept by retention. ' +
    'Requires `type`, `signalName`, and exactly one of `signalId` or `idempotencyKey` (not ' +
    'both). Accepts `input`, `signalPayload`, and the non-idempotency start options from ' +
    'weft.workflows.start (`id`, `executionTimeout`, `startAt`/`startAfter`, `tags`, ' +
    '`searchAttributes`); `idempotencyKey` is governed solely by the "exactly one of" rule above. ' +
    'Returns the workflow `id`. Concurrent callers converge on one workflow ' +
    'and one signal only with a shared `idempotencyKey`, or a shared `id` plus `signalId`; a ' +
    'bare `signalId` (no `id`/`idempotencyKey`) starts a fresh run per caller and does not ' +
    'converge.',
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
      const { handle, outcome } = await typedEngine.startOrSignal(
        type,
        input.input,
        signal,
        options,
      );
      return { id: handle.id, outcome };
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
  extractInput: async (request, _pathParams, context) => {
    const record = await parseStartWorkflowRequestRecord(request, context);
    return {
      ...extractSharedStartWorkflowRestFields(record),
      signalName: record['signalName'],
      signalPayload: record['signalPayload'],
      signalId: record['signalId'],
    };
  },
  success: { kind: 'json', status: 201 },
  shapeFault: shapeRestFault,
};
