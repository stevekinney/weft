import { z } from 'zod';

import { type OperationFault, defineOperation } from "../../embedded/backchannel/src/index.ts";
import { type UnknownRestBinding, invalidParamsFault } from "../../embedded/backchannel/src/internals.ts";
import {
  IdempotencyKeyPurgedError,
  StartOrSignalConflictError,
  WorkflowNotRegisteredError,
  WorkflowTeardownPendingError,
} from '../../core/engine/errors.ts';
import { runtimeWorkflowEngine } from '../../core/runtime-workflow-engine.ts';
import { isSignalIdWithinByteLimit } from '../../core/signal-id.ts';
import {
  StartWorkflowValidationError,
  WorkerStartOverrideRejectedError,
} from '../../core/start-workflow-validation.ts';
import type {
  SearchAttributeSchema,
  StartOrSignalOptions,
  StartOrSignalSignal,
} from '../../core/types.ts';
import { standardSchemaValidationFault } from '../standard-schema-validation-fault.ts';
import {
  undeclaredMessageFault,
  workerStartOverrideRejectedFault,
  workerVersionRemovedFault,
} from './operation-helpers.ts';
import { buildStartOrSignalWorkflowOptions } from './start-workflow-options.ts';
import {
  extractSharedStartWorkflowRestFields,
  parseStartWorkflowRequestRecord,
} from './start-workflow-rest-input.ts';

// Permissive at the schema boundary so all field validation lives in `invoke()`,
// giving one cross-transport contract (mirrors weft.workflows.start).
const startOrSignalWorkflowInput = z.object({
  type: z.unknown().describe('Workflow type name. Runtime validation requires a non-empty string.'),
  input: z
    .unknown()
    .optional()
    .describe(
      'Input payload handed to the workflow body. Omit it for a workflow that takes no input.',
    ),
  signalName: z.string().min(1).describe('Signal name. Must be a non-empty string.'),
  signalPayload: z.unknown().optional().describe('Payload delivered with the signal.'),
  signalId: z
    .string()
    .min(1)
    .refine(isSignalIdWithinByteLimit, 'signalId must be at most 128 bytes')
    .optional()
    .describe(
      'Id of the signal to deliver. Provide exactly one of signalId or idempotencyKey. Concurrent callers converge on one run and one signal only when they share both id and signalId; a bare signalId, without id, starts a fresh run per caller. Required for onTerminalConflict "start-new". At most 128 bytes.',
    ),
  id: z
    .unknown()
    .optional()
    .describe(
      'Client-chosen id of the target workflow. Omit it to have one generated. An absent id is created and signalled (outcome "started"); a non-terminal run with this id is signalled (outcome "signalled"); a finished run with this id faults with Conflict unless onTerminalConflict is "start-new".',
    ),
  executionTimeout: z
    .unknown()
    .optional()
    .describe(
      'Total time the run may take before it times out: milliseconds, or a duration string such as "30s".',
    ),
  startAt: z
    .unknown()
    .optional()
    .describe(
      'Absolute start time as a non-negative integer millisecond timestamp. Mutually exclusive with startAfter.',
    ),
  startAfter: z
    .unknown()
    .optional()
    .describe(
      'Delay before the run starts: milliseconds, or a duration string such as "5m". Mutually exclusive with startAt.',
    ),
  tags: z
    .unknown()
    .optional()
    .describe('Tags to attach to the run, as an array of non-empty strings.'),
  idempotencyKey: z
    .unknown()
    .optional()
    .describe(
      'Alternative to signalId; provide exactly one. Callers sharing a key converge on one run and one delivered signal (the signal id derives from the key), and a repeated key signals the run it first started instead of starting another. A key whose run was purged by retention faults with Conflict. Cannot be combined with signalId or with onTerminalConflict "start-new".',
    ),
  searchAttributes: z
    .unknown()
    .optional()
    .describe(
      "Search attributes to index the run under, keyed by attribute name. Validated against the workflow type's declared schema; date-time values are ISO 8601 strings.",
    ),
  onTerminalConflict: z
    .unknown()
    .optional()
    .describe(
      'What to do when the supplied id belongs to a finished run: "error" (default) faults, "start-new" replaces it with a fresh run. "start-new" requires id and signalId and excludes idempotencyKey.',
    ),
  workerStartOverridePreview: z
    .unknown()
    .optional()
    .describe(
      'Signed preview that authorises starting on a worker deployment other than the routed one. Supply the object an override preview returned.',
    ),
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
  options: StartOrSignalOptions;
} {
  if (typeof input.type !== 'string' || input.type.length === 0) {
    throw invalidParamsFault('Missing required field: type');
  }
  // `signalName` is `z.string().min(1)` — Zod rejects an absent or empty value
  // at the schema boundary before `invoke`, so no manual guard is needed here.

  let options: StartOrSignalOptions;
  try {
    options = buildStartOrSignalWorkflowOptions(input, lookupSearchAttributeSchema(input.type));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw invalidParamsFault(message);
  }

  assertConvergenceTokenProvided(input.signalId, options);

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
  options: StartOrSignalOptions,
): void {
  if (options.onTerminalConflict === 'start-new' && signalId === undefined) {
    throw invalidParamsFault(
      "startOrSignal options.onTerminalConflict: 'start-new' requires signalId so " +
        'concurrent restart-capable callers converge on one deterministic initial signal.',
    );
  }
  if (signalId === undefined && options.idempotencyKey === undefined) {
    throw invalidParamsFault(
      'startOrSignal requires either signalId or idempotencyKey to identify the signal to ' +
        'deliver. (Concurrent callers converge on one workflow and one signal only with a shared ' +
        'idempotencyKey, or a shared id plus signalId; a bare signalId starts a fresh run per ' +
        'caller.)',
    );
  }
  if (signalId !== undefined && options.idempotencyKey !== undefined) {
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
 *   4. WorkflowTeardownPendingError → Conflict (terminal cleanup not done)
 *   5. WorkerStartOverrideRejectedError → Conflict (`reason: "override-token-rejected"`)
 *   6. WorkerDeploymentVersionRemovedError → Conflict (`reason: "version-removed"`)
 *   7. StartWorkflowValidationError → InvalidParams
 *   8. StandardSchemaValidationError → InvalidParams (declared input or signal schema)
 *   9. otherwise                    → EngineFailure
 */
/** A start bound to a removed build answers Conflict; a signal the target does not declare, Unprocessable. */
function removedBuildOrUndeclaredSignalFault(error: unknown): OperationFault | undefined {
  return workerVersionRemovedFault(error) ?? undeclaredMessageFault(error);
}

function resolveStartOrSignalWorkflowFault(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);

  if (error instanceof WorkflowNotRegisteredError) {
    throw invalidParamsFault(message, error.code);
  }
  if (
    error instanceof StartOrSignalConflictError ||
    error instanceof IdempotencyKeyPurgedError ||
    error instanceof WorkflowTeardownPendingError
  ) {
    // These are client-actionable convergence conflicts: a terminal target, a
    // spent key whose run was purged, or a terminal run still waiting on teardown.
    // Surface as Conflict (409) so callers can retry or choose a different
    // identity — not an opaque masked 500.
    // `weftCode` recovers which collapsed typed error this was, including the
    // transient teardown-pending case that clients can retry.
    const data: Extract<OperationFault, { code: 'Conflict' }>['data'] = {
      reason: message,
      weftCode: error.code,
    };
    const fault: OperationFault = {
      code: 'Conflict',
      message,
      data,
    };
    throw fault;
  }
  if (error instanceof WorkerStartOverrideRejectedError) {
    throw workerStartOverrideRejectedFault(message);
  }
  const typedFault = removedBuildOrUndeclaredSignalFault(error);
  if (typedFault !== undefined) throw typedFault;
  if (error instanceof StartWorkflowValidationError) {
    throw invalidParamsFault(message);
  }
  const schemaFault = standardSchemaValidationFault(error);
  if (schemaFault !== undefined) throw schemaFault;

  const fault: OperationFault = {
    code: 'EngineFailure',
    message,
    data: {},
  };
  throw fault;
}

type StartOrSignalWorkflowOperationOptions = Readonly<{
  workerStartOverrideSigningSecret?: string;
}>;

export function createStartOrSignalWorkflowOperation(
  configuration: StartOrSignalWorkflowOperationOptions = {},
) {
  return defineOperation({
    name: 'weft.workflows.startorsignal',
    mcpExposable: false,
    summary: 'Atomically start a workflow or signal it if it already exists',
    description:
      'Start a workflow or deliver a signal to it if it already exists (signal-with-start). An ' +
      'absent target is created and delivered the signal in one batch; a non-terminal target ' +
      '(running, pending, or suspended) is signalled; a terminal target faults with Conflict unless ' +
      '`onTerminalConflict: "start-new"` is supplied with `id` and `signalId`, in which case the ' +
      'prior terminal run is replaced through the shared terminal-replacement path and the initial ' +
      'signal is delivered to the fresh run. A spent `idempotencyKey` whose run was purged or swept ' +
      'by retention also faults with Conflict. A signal name the target declares no signal for, ' +
      'when it declares its signals, faults with Unprocessable. ' +
      'Requires `type`, `signalName`, and exactly one of `signalId` or `idempotencyKey` (not ' +
      'both). Accepts `input`, `signalPayload`, and the non-idempotency start options from ' +
      'weft.workflows.start (`id`, `executionTimeout`, `startAt`/`startAfter`, `tags`, ' +
      '`searchAttributes`) plus `onTerminalConflict`; `idempotencyKey` is governed by the ' +
      '"exactly one of" rule above and cannot be combined with restart. ' +
      'Returns the workflow `id`. Concurrent callers converge on one workflow ' +
      'and one signal only with a shared `idempotencyKey`, or a shared `id` plus `signalId`; a ' +
      'bare `signalId` (no `id`/`idempotencyKey`) starts a fresh run per caller and does not ' +
      'converge.',
    destructive: true,
    tags: ['Workflows', 'Signals'],
    inputSchema: startOrSignalWorkflowInput,
    outputSchema: startOrSignalWorkflowOutput,
    // Every call carries a signal (`signalName` is required), so a caller that
    // could start but not signal would otherwise signal a running workflow
    // through here. Both scopes are required.
    access: {
      kind: 'scoped',
      scopes: { kind: 'allOf', scopes: ['workflows:write', 'signals:write'] },
    },
    discoverable: true,
    producibleFaults: ['Conflict', 'Unprocessable'],
    transports: { http: true, jsonRpcHttp: true, jsonRpcWebSocket: true, jsonRpcStdio: true },
    unknownKeyPolicy: { http: 'strip', jsonRpc: 'reject' },
    invoke: async ({ input, host: engine }): Promise<StartOrSignalWorkflowOutput> => {
      const typedEngine = runtimeWorkflowEngine(engine);
      const { type, signal, options } = validateStartOrSignalWorkflowInput(input, (validType) => {
        return typedEngine.getWorkflowDefinition(validType)?.searchAttributes;
      });

      try {
        const { handle, outcome } = await typedEngine.startOrSignal(type, input.input, signal, {
          ...options,
          ...(options.workerStartOverridePreview === undefined ||
          configuration.workerStartOverrideSigningSecret === undefined
            ? {}
            : { workerStartOverrideSigningSecret: configuration.workerStartOverrideSigningSecret }),
        });
        return { id: handle.id, outcome };
      } catch (error) {
        return resolveStartOrSignalWorkflowFault(error);
      }
    },
  });
}

export const startOrSignalWorkflowOperation = createStartOrSignalWorkflowOperation();

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
    onTerminalConflict: { kind: 'body-field', bodyField: 'onTerminalConflict' },
    workerStartOverridePreview: { kind: 'body-field', bodyField: 'workerStartOverridePreview' },
  },
  extractInput: async (request, _pathParams, context) => {
    const record = await parseStartWorkflowRequestRecord(request, context);
    return {
      ...extractSharedStartWorkflowRestFields(record),
      signalName: record['signalName'],
      signalPayload: record['signalPayload'],
      signalId: record['signalId'],
      onTerminalConflict: record['onTerminalConflict'],
    };
  },
  success: { kind: 'json', status: 201 },
};
