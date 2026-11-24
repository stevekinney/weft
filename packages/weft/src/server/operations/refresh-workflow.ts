/**
 * `weft.workflows.refresh` operation + REST binding.
 *
 * Runs one conditional check for a workflow's opted-in refresh source: fetch
 * with the last ETag, validate the immutable candidate artifact, warm it,
 * install it, and, when asked, activate it under a generation fence. A thin,
 * documented exposure of `engine.workflows.refresh()`, modeled on
 * `preload-workflow-revision.ts`.
 *
 * Registering a refresh source is not an operation: a source is code the host
 * supplies (`fetch`, `warm`, `validateRuntime`), which a request cannot carry.
 *
 * A check that installs a candidate but does not activate it (a stale
 * generation, an incompatible contract) succeeds with the catalog's structured
 * refusal in `activation`, because the candidate is installed; only a failed
 * check is a fault. A failed check's fault carries a bounded `reason`, never
 * the host's own message, which can name a path or a credentialed URL.
 *
 * @module server/operations/refresh-workflow
 */

import { z } from 'zod';

import { type OperationFault, defineOperation } from "../../embedded/backchannel/src/index.ts";
import { type UnknownRestBinding, invalidParamsFault } from "../../embedded/backchannel/src/internals.ts";
import {
  type WorkflowCatalogActivationResult,
  WorkflowRefreshError,
  type WorkflowRefreshFailureReason,
  type WorkflowRefreshResult,
} from '../../core/catalog/index.ts';
import { assertOperationWorkflowMethods } from './operation-helpers.ts';
import {
  readWorkflowCatalogRestBody,
  throwWorkflowCatalogOperationFault,
  validateExpectedGenerationField,
  validateWorkflowNameField,
  workflowsAdminAccess,
} from './workflow-catalog-operation-helpers.ts';

const refreshWorkflowInput = z.object({
  name: z.unknown().describe('Workflow name. Runtime validation requires a wire-safe identifier.'),
  activate: z
    .unknown()
    .optional()
    .describe(
      'Activation mode: `never` (the default) installs and warms the candidate without changing ' +
        'the active pointer; `if-compatible` also activates it under the generation fence.',
    ),
  expectedGeneration: z
    .unknown()
    .optional()
    .describe(
      'The durable generation this caller last observed. Required to activate once the workflow ' +
        'has an active revision.',
    ),
});

const activationPointerSchema = z
  .object({
    revision: z.string(),
    generation: z.number().int().nonnegative(),
    activatedAt: z.number().nonnegative(),
  })
  .strict();

const refreshActivationSchema = z.union([
  z.object({ applied: z.literal(true), pointer: activationPointerSchema }).strict(),
  z
    .object({
      applied: z.literal(false),
      reason: z.literal('incompatible'),
      compatibilityReasons: z.array(z.string()),
    })
    .strict(),
  z
    .object({
      applied: z.literal(false),
      reason: z.enum(['stale-generation', 'expected-generation-required']),
      currentGeneration: z.number().int().nonnegative(),
    })
    .strict(),
  z.object({ applied: z.literal(false), reason: z.literal('conflict') }).strict(),
]);

const refreshWorkflowOutput = z
  .object({
    status: z.enum(['not-modified', 'installed', 'activated']),
    etag: z.string().optional(),
    revision: z.string().optional(),
    contractHash: z.string().optional(),
    activation: refreshActivationSchema.optional(),
  })
  .strict();

export type RefreshWorkflowInput = z.infer<typeof refreshWorkflowInput>;
export type RefreshWorkflowOutput = z.infer<typeof refreshWorkflowOutput>;

function validateActivateField(value: unknown): 'never' | 'if-compatible' | undefined {
  if (value === undefined) return undefined;
  if (value === 'never' || value === 'if-compatible') return value;
  throw invalidParamsFault('Field "activate" must be "never" or "if-compatible"');
}

function activationOutput(
  activation: WorkflowCatalogActivationResult,
): NonNullable<RefreshWorkflowOutput['activation']> {
  if (activation.applied) {
    const { revision, generation, activatedAt } = activation.pointer;
    return { applied: true, pointer: { revision, generation, activatedAt } };
  }
  switch (activation.reason) {
    case 'incompatible':
      return {
        applied: false,
        reason: 'incompatible',
        compatibilityReasons: activation.verdict.compatible ? [] : [...activation.verdict.reasons],
      };
    case 'stale-generation':
    case 'expected-generation-required':
      return {
        applied: false,
        reason: activation.reason,
        currentGeneration: activation.currentGeneration,
      };
  }
  // Every other refusal is handled above, so this is the last variant. Adding one makes this
  // assignment a compile error, which forces a deliberate wire mapping.
  const conflict: { readonly reason: 'conflict' } = activation;
  return { applied: false, reason: conflict.reason };
}

function refreshOutput(result: WorkflowRefreshResult): RefreshWorkflowOutput {
  return {
    status: result.status,
    ...(result.etag === undefined ? {} : { etag: result.etag }),
    ...(result.manifest === undefined
      ? {}
      : { revision: result.manifest.revision, contractHash: result.manifest.contractHash }),
    ...(result.activation === undefined ? {} : { activation: activationOutput(result.activation) }),
  };
}

/** The fault a typed refresh failure takes, by reason. Every message is fixed text: the host's own message never crosses the wire. */
const REFRESH_FAILURE_FAULTS = {
  source: {
    code: 'Unavailable',
    message: 'The refresh source could not be reached or returned an unusable response.',
  },
  stopped: { code: 'Unavailable', message: 'Workflow refresh is stopped.' },
  integrity: {
    code: 'Conflict',
    message: 'The candidate artifact failed its integrity checks. Nothing was installed.',
  },
  identity: {
    code: 'Conflict',
    message:
      'The candidate artifact is not the requested workflow and revision. Nothing was installed.',
  },
  contract: {
    code: 'Conflict',
    message:
      'The candidate artifact carries an invalid manifest or contract hash. Nothing was installed.',
  },
  runtime: {
    code: 'Conflict',
    message: 'The candidate artifact was refused by the runtime check. Nothing was installed.',
  },
  warming: {
    code: 'Conflict',
    message: 'The candidate artifact failed to warm. Nothing was installed.',
  },
} as const satisfies Partial<
  Record<WorkflowRefreshFailureReason, { code: 'Unavailable' | 'Conflict'; message: string }>
>;

function isMappedFailure(
  reason: WorkflowRefreshFailureReason,
): reason is keyof typeof REFRESH_FAILURE_FAULTS {
  return reason in REFRESH_FAILURE_FAULTS;
}

function refreshFailureFault(reason: keyof typeof REFRESH_FAILURE_FAULTS): OperationFault {
  const { code, message } = REFRESH_FAILURE_FAULTS[reason];
  const data = { reason: `refresh-${reason}` };
  return code === 'Unavailable' ? { code, message, data } : { code, message, data };
}

/**
 * Map a failed check to its fault. A typed refresh failure carries only its
 * bounded `reason` onto the wire; a catalog error takes the shared catalog
 * mapping; anything else is rethrown for the pipeline's generic masking.
 */
function throwRefreshFault(name: string, error: unknown): never {
  if (error instanceof WorkflowRefreshError) {
    if (error.reason === 'not-registered') {
      const fault: OperationFault = {
        code: 'NotFound',
        message: `No workflow refresh source is registered for "${name}".`,
        data: { resource: 'workflow-refresh-source', identifier: name },
      };
      throw fault;
    }
    if (isMappedFailure(error.reason)) throw refreshFailureFault(error.reason);
  }
  return throwWorkflowCatalogOperationFault(error);
}

export const refreshWorkflowOperation = defineOperation({
  name: 'weft.workflows.refresh',
  mcpExposable: false,
  summary: "Check a workflow's refresh source and install or activate its candidate",
  description:
    "Run one conditional check for `name`'s opted-in refresh source: fetch with the last ETag " +
    '(a `304` is `not-modified`), validate the candidate artifact, warm and install it, and ' +
    'with `activate: "if-compatible"` activate it under the generation fence. A candidate that ' +
    'is installed but not activated (a stale generation, an incompatible contract) returns ' +
    '`installed` with the structured refusal in `activation`. Faults NotFound when no source is ' +
    'registered, Unavailable when the source cannot be reached, and Conflict with `reason` ' +
    '`refresh-integrity`, `refresh-identity`, `refresh-contract`, `refresh-runtime`, or ' +
    '`refresh-warming` when the candidate is refused; a refused candidate is not installed. The ' +
    '`data.reason` of a fault is disclosed over JSON-RPC only; the REST projection omits it.',
  // Can move the active pointer, like `weft.workflows.revisions.activate`.
  destructive: true,
  tags: ['Workflow Catalog'],
  inputSchema: refreshWorkflowInput,
  outputSchema: refreshWorkflowOutput,
  access: workflowsAdminAccess,
  producibleFaults: ['InvalidParams', 'NotFound', 'Conflict', 'Unavailable'],
  discoverable: true,
  transports: { http: true, jsonRpcHttp: true, jsonRpcWebSocket: true, jsonRpcStdio: true },
  unknownKeyPolicy: { http: 'strip', jsonRpc: 'reject' },
  invoke: async ({ input, host: engine }): Promise<RefreshWorkflowOutput> => {
    assertOperationWorkflowMethods(engine, ['refresh']);
    const e = engine;
    const name = validateWorkflowNameField(input.name);
    const activate = validateActivateField(input.activate);
    const expectedGeneration = validateExpectedGenerationField(input.expectedGeneration);

    try {
      return refreshOutput(
        await e.workflows.refresh(name, {
          ...(activate === undefined ? {} : { activate }),
          ...(expectedGeneration === undefined ? {} : { expectedGeneration }),
        }),
      );
    } catch (error) {
      return throwRefreshFault(name, error);
    }
  },
});

export const refreshWorkflowRestBinding: UnknownRestBinding = {
  method: 'POST',
  path: '/v1/registry/workflows/:name/refresh',
  pathParamNames: ['name'],
  operationName: 'weft.workflows.refresh',
  inputSources: {
    name: { kind: 'path', pathParam: 'name' },
    activate: { kind: 'body-field', bodyField: 'activate' },
    expectedGeneration: { kind: 'body-field', bodyField: 'expectedGeneration' },
  },
  extractInput: async (request, pathParams, context) => {
    const body = await readWorkflowCatalogRestBody(request, context);
    return {
      name: pathParams['name'] ?? '',
      activate: body['activate'],
      expectedGeneration: body['expectedGeneration'],
    };
  },
  success: { kind: 'json', status: 200 },
};
