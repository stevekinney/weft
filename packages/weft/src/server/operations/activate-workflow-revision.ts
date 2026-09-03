/**
 * `weft.workflows.revisions.activate` operation + REST binding.
 *
 * Activates an already-installed `(name, revision)` as the durably
 * advertised active revision — bookkeeping only. See
 * `core/engine/engine-workflows-namespace.ts`'s module doc: activation
 * moves `RegistrySnapshot.activeRevisions`, never which in-process handler
 * `engine.start()` dispatches to.
 *
 * @module server/operations/activate-workflow-revision
 */

import { z } from 'zod';

import type { WorkflowCatalogActivationResult } from '../../core/catalog/index.ts';
import type { Engine } from '../../core/engine.ts';
import { defineOperation } from '../operation-registry.ts';
import type { UnknownRestBinding } from '../rest-bindings.ts';
import {
  activationRefusalToFault,
  readWorkflowCatalogRestBody,
  throwWorkflowCatalogOperationFault,
  validateExpectedGenerationField,
  validatePolicyField,
  validateWorkflowNameField,
  validateWorkflowRevisionField,
  workflowsAdminAccess,
} from './workflow-catalog-operation-helpers.ts';

const activateWorkflowRevisionInput = z.object({
  name: z.unknown().describe('Workflow name. Runtime validation requires a wire-safe identifier.'),
  revision: z
    .unknown()
    .describe('Installed revision to activate. Runtime validation requires a non-empty string.'),
  expectedGeneration: z
    .unknown()
    .optional()
    .describe(
      'The durable generation this caller last observed. Required once the workflow has an ' +
        'active revision — omitting it there refuses with expected-generation-required.',
    ),
  policy: z.unknown().optional().describe('Optional compatibility policy override.'),
});
const activateWorkflowRevisionOutput = z.unknown();

export type ActivateWorkflowRevisionInput = z.infer<typeof activateWorkflowRevisionInput>;
export type ActivateWorkflowRevisionOutput = WorkflowCatalogActivationResult;

export const activateWorkflowRevisionOperation = defineOperation<
  ActivateWorkflowRevisionInput,
  ActivateWorkflowRevisionOutput
>({
  name: 'weft.workflows.revisions.activate',
  mcpExposable: false,
  summary: 'Activate an installed workflow revision',
  description:
    'Activate an already-installed `(name, revision)` as the durably advertised active revision ' +
    'for `name`. Returns the structured result verbatim: `{ applied: true, pointer }` on success, ' +
    'or `{ applied: false, reason, ... }` on refusal — surfaced as a Conflict fault with `reason` ' +
    'one of `incompatible`, `stale-generation`, `expected-generation-required`, or `conflict`. ' +
    'Faults with NotFound when the revision was never installed. Never changes which in-process ' +
    'handler `engine.start()` dispatches to — see the workflow-versioning guide.',
  destructive: true,
  tags: ['Workflow Catalog'],
  inputSchema: activateWorkflowRevisionInput,
  outputSchema: activateWorkflowRevisionOutput as z.ZodType<ActivateWorkflowRevisionOutput>,
  access: workflowsAdminAccess,
  producibleFaults: ['NotFound', 'Conflict', 'InvalidParams'],
  discoverable: true,
  transports: { http: true, jsonRpcHttp: true, jsonRpcWebSocket: true, jsonRpcStdio: true },
  unknownKeyPolicy: { http: 'strip', jsonRpc: 'reject' },
  invoke: async ({ input, engine }): Promise<ActivateWorkflowRevisionOutput> => {
    const e = engine as Engine;
    const name = validateWorkflowNameField(input.name);
    const revision = validateWorkflowRevisionField(input.revision);
    const expectedGeneration = validateExpectedGenerationField(input.expectedGeneration);
    const policy = validatePolicyField(input.policy);

    let result: WorkflowCatalogActivationResult;
    try {
      result = await e.workflows.activate(name, revision, {
        ...(expectedGeneration === undefined ? {} : { expectedGeneration }),
        ...(policy === undefined ? {} : { policy }),
      });
    } catch (error) {
      throwWorkflowCatalogOperationFault(error);
    }

    if (!result.applied) {
      throw activationRefusalToFault(result);
    }
    return result;
  },
});

export const activateWorkflowRevisionRestBinding: UnknownRestBinding = {
  method: 'POST',
  path: '/v1/registry/workflows/:name/activate',
  pathParamNames: ['name'],
  operationName: 'weft.workflows.revisions.activate',
  inputSources: {
    name: { kind: 'path', pathParam: 'name' },
    revision: { kind: 'body-field', bodyField: 'revision' },
    expectedGeneration: { kind: 'body-field', bodyField: 'expectedGeneration' },
    policy: { kind: 'body-field', bodyField: 'policy' },
  },
  extractInput: async (request, pathParams, context) => {
    const body = await readWorkflowCatalogRestBody(request, context);
    return {
      name: pathParams['name'] ?? '',
      revision: body['revision'],
      expectedGeneration: body['expectedGeneration'],
      policy: body['policy'],
    };
  },
  success: { kind: 'json', status: 200 },
};
