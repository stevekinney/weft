import { z } from 'zod';

import type { Engine } from '../../core/engine.ts';
import { ForkSourceReplacedError } from '../../core/engine/errors.ts';
import type { ForkOptions } from '../../core/types.ts';
import { VersionMismatchError } from '../../core/versioning.ts';
import type { OperationFault } from '../operation-fault.ts';
import { defineOperation } from '../operation-registry.ts';
import type { UnknownRestBinding } from '../rest-bindings.ts';
import { readRestTextBody } from '../rest-body.ts';
import { invalidParamsFault } from './operation-helpers.ts';
import { mapRevisionUnavailableToFault } from './revision-unavailable-fault.ts';

// `fromStep` is intentionally `unknown` at the schema boundary. The exact
// "Field 'fromStep' must be a non-negative safe integer" error path
// lives in `invoke()` so REST and JSON-RPC callers share one contract.
const forkWorkflowInput = z.object({
  workflowId: z.string().min(1),
  fromStep: z.unknown().optional(),
  /**
   * Explicit opt-in (WFT-21) to fork against a DIFFERENT installed revision
   * than the source run's own pin — see `ForkOptions.revision`'s own doc
   * for the full validation contract. Omitted: the fork resolves and
   * persists the source run's own revision, unchanged from before this
   * field existed.
   */
  revision: z.string().min(1).optional(),
});

const forkWorkflowOutput = z.object({
  id: z.string(),
});

export type ForkWorkflowInput = z.infer<typeof forkWorkflowInput>;
export type ForkWorkflowOutput = z.infer<typeof forkWorkflowOutput>;

/**
 * Validate the `fromStep` and `revision` fields of a fork request.
 *
 * Returns the resolved fork options — `undefined` only when NEITHER field
 * was provided (matching `engine.fork()`'s own `options?: ForkOptions`
 * contract). Throws an `InvalidParams` fault if `fromStep` is present but
 * not a non-negative safe integer. `revision` needs no format validation
 * here — the schema already requires a non-empty string, and an
 * unresolvable value is the engine's own `WorkflowRevisionUnavailableError`
 * (mapped to a `Conflict` fault below), not a client-input shape error.
 */
function validateForkInput(input: ForkWorkflowInput): ForkOptions | undefined {
  if (input.fromStep === undefined && input.revision === undefined) {
    return undefined;
  }
  const options: ForkOptions = {};
  if (input.fromStep !== undefined) {
    if (
      typeof input.fromStep !== 'number' ||
      !Number.isSafeInteger(input.fromStep) ||
      input.fromStep < 0
    ) {
      throw invalidParamsFault('Field "fromStep" must be a non-negative safe integer');
    }
    options.fromStep = input.fromStep;
  }
  if (input.revision !== undefined) {
    options.revision = input.revision;
  }
  return options;
}

/**
 * Map an engine error thrown by `engine.fork` to the canonical operation fault.
 *
 * Routing order:
 *   1. `WorkflowRevisionUnavailableError`           → Conflict (409), typed check
 *      first so its message text never accidentally matches a substring
 *      branch below (e.g. its own "not registered" text could otherwise
 *      match the generic 'not found' branch).
 *   2. `VersionMismatchError`                       → Conflict (409), typed check
 *      (Codex review round 11, P2 — see below)
 *   3. `ForkSourceReplacedError`                    → Conflict (409), typed check
 *      (Codex review, item 6 — the source run was replaced by a concurrent
 *      `start-new` while this fork was still resolving or committing, a
 *      legitimate retryable race, not an engine failure)
 *   4. 'fromStep' / 'Checkpoint not found at step' → InvalidParams (400)
 *   5. 'Checkpoint not found'                       → NotFound, resource: 'checkpoint'
 *   6. 'not found'                                  → NotFound, resource: 'workflow'
 *   7. otherwise                                    → EngineFailure
 */
export function resolveForkAccess(error: unknown): never {
  const revisionFault = mapRevisionUnavailableToFault(error);
  if (revisionFault !== undefined) {
    throw revisionFault;
  }

  // WFT-21, Codex review round 11, P2: an explicit-revision fork onto a
  // registered revision whose WORKFLOW VERSION is semver-incompatible with
  // the source checkpoint is a deterministic, caller-selected outcome —
  // `derivePreparedExecutionState()` throws `VersionMismatchError` for
  // exactly this case (see `ForkOptions.revision`'s own doc: "a semver-
  // incompatible target version still throws VersionMismatchError... an
  // explicit revision never bypasses ordinary compatibility checking").
  // Before this typed check, that error fell through every branch below —
  // its message never mentions "not found" or "fromStep" — landing on the
  // generic `EngineFailure`, masking a documented Conflict as a REST 500 /
  // undeclared JSON-RPC engine failure. Checked before the substring
  // branches for the same reason the revision check above is: its own
  // message text must never accidentally match one of them.
  if (error instanceof VersionMismatchError) {
    const fault: OperationFault = {
      code: 'Conflict',
      message: error.message,
      data: { reason: error.message, weftCode: error.code },
    };
    throw fault;
  }

  // WFT-21, Codex review, item 6: the source run was replaced by a
  // concurrent `start-new` while this fork was still resolving or
  // committing — a legitimate, retryable race, not an engine failure.
  // Checked before the substring branches below for the same reason the
  // two typed checks above are.
  if (error instanceof ForkSourceReplacedError) {
    const fault: OperationFault = {
      code: 'Conflict',
      message: error.message,
      data: { reason: error.message, weftCode: error.code },
    };
    throw fault;
  }

  const message = error instanceof Error ? error.message : String(error);

  if (message.includes('fromStep') || message.includes('Checkpoint not found at step')) {
    throw invalidParamsFault(message);
  }
  if (message.includes('Checkpoint not found')) {
    const fault: OperationFault = {
      code: 'NotFound',
      message,
      data: { resource: 'checkpoint' },
    };
    throw fault;
  }
  if (message.includes('not found')) {
    const fault: OperationFault = {
      code: 'NotFound',
      message,
      data: { resource: 'workflow' },
    };
    throw fault;
  }

  const fault: OperationFault = {
    code: 'EngineFailure',
    message,
    data: {},
  };
  throw fault;
}

export const forkWorkflowOperation = defineOperation<ForkWorkflowInput, ForkWorkflowOutput>({
  name: 'weft.workflows.fork',
  mcpExposable: false,
  summary: 'Fork a workflow from a checkpoint',
  destructive: false,
  tags: ['Workflows'],
  inputSchema: forkWorkflowInput,
  outputSchema: forkWorkflowOutput,
  access: { kind: 'public' },
  producibleFaults: ['NotFound', 'Conflict'],
  transports: { http: true, jsonRpcHttp: true, jsonRpcWebSocket: true, jsonRpcStdio: true },
  unknownKeyPolicy: { http: 'strip', jsonRpc: 'reject' },
  invoke: async ({ input, engine }): Promise<ForkWorkflowOutput> => {
    const typedEngine = engine as Engine;
    const options = validateForkInput(input);

    try {
      const handle = await typedEngine.fork(input.workflowId, options);
      return { id: handle.id };
    } catch (error) {
      return resolveForkAccess(error);
    }
  },
});

export const forkWorkflowRestBinding: UnknownRestBinding = {
  method: 'POST',
  path: '/v1/workflows/:id/fork',
  pathParamNames: ['id'],
  operationName: 'weft.workflows.fork',
  inputSources: {
    workflowId: { kind: 'path', pathParam: 'id' },
    fromStep: { kind: 'body-field', bodyField: 'fromStep' },
    revision: { kind: 'body-field', bodyField: 'revision' },
  },
  extractInput: async (request, pathParams, context) => {
    const rawBody = await readRestTextBody(request, context);
    if (rawBody.trim().length === 0) {
      return { workflowId: pathParams['id'] ?? '' };
    }

    let body: unknown;
    try {
      body = JSON.parse(rawBody) as unknown;
    } catch {
      throw invalidParamsFault('Invalid JSON body');
    }

    // arrays are explicitly rejected here (handleForkWorkflow
    // uses the same `Array.isArray(body)` guard); `fromStep` validation lives
    // in `invoke` so REST and JSON-RPC share one error path.
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      throw invalidParamsFault('Request body must be a JSON object');
    }

    const record = body as Record<string, unknown>;
    return {
      workflowId: pathParams['id'] ?? '',
      fromStep: record['fromStep'],
      revision: record['revision'],
    };
  },
  success: { kind: 'json', status: 201 },
};
