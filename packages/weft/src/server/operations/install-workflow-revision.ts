/**
 * `weft.workflows.revisions.install` operation + REST binding.
 *
 * Durably installs a validated {@link WorkflowRevisionManifest} for a
 * workflow the engine already has an in-process definition for. Catalog
 * bookkeeping only — see `core/engine/engine-workflows-namespace.ts`'s
 * module doc: installing (and later activating) a revision never changes
 * which in-process handler `engine.start()` dispatches to.
 *
 * @module server/operations/install-workflow-revision
 */

import { z } from 'zod';

import type { WorkflowRevisionRecord } from '../../core/catalog/index.ts';
import type { Engine } from '../../core/engine.ts';
import { defineOperation } from '../operation-registry.ts';
import type { UnknownRestBinding } from '../rest-bindings.ts';
import {
  readWorkflowCatalogRestBody,
  throwWorkflowCatalogOperationFault,
  validateManifestField,
  workflowsAdminAccess,
} from './workflow-catalog-operation-helpers.ts';

const installWorkflowRevisionInput = z.object({
  manifest: z
    .unknown()
    .describe('An untrusted WorkflowRevisionManifest, validated at invoke time.'),
});
const installWorkflowRevisionOutput = z.unknown();

export type InstallWorkflowRevisionInput = z.infer<typeof installWorkflowRevisionInput>;
export type InstallWorkflowRevisionOutput = WorkflowRevisionRecord;

export const installWorkflowRevisionOperation = defineOperation<
  InstallWorkflowRevisionInput,
  InstallWorkflowRevisionOutput
>({
  name: 'weft.workflows.revisions.install',
  mcpExposable: false,
  summary: 'Durably install a workflow revision manifest',
  description:
    'Validate and durably install a `WorkflowRevisionManifest` for a workflow the engine already ' +
    'has an in-process definition for. Idempotent on a byte-identical reinstall of the same ' +
    '(name, revision). Faults with InvalidParams when the manifest fails validation or names a ' +
    'workflow with no in-process definition, and Conflict when (name, revision) is already ' +
    'installed with different contract content. Does not check `manifest.workflowVersion` ' +
    "against the in-process definition's own version — that mismatch is a normal " +
    'activation-time `incompatible` refusal, not an install-time error. Never changes which ' +
    'in-process handler `engine.start()` dispatches to.',
  destructive: false,
  tags: ['Workflow Catalog'],
  inputSchema: installWorkflowRevisionInput,
  outputSchema: installWorkflowRevisionOutput as z.ZodType<InstallWorkflowRevisionOutput>,
  access: workflowsAdminAccess,
  producibleFaults: ['InvalidParams', 'Conflict'],
  discoverable: true,
  transports: { http: true, jsonRpcHttp: true, jsonRpcWebSocket: true, jsonRpcStdio: true },
  unknownKeyPolicy: { http: 'strip', jsonRpc: 'reject' },
  invoke: async ({ input, engine }): Promise<InstallWorkflowRevisionOutput> => {
    const e = engine as Engine;
    const manifest = await validateManifestField(input.manifest);
    try {
      return await e.workflows.install(manifest);
    } catch (error) {
      throwWorkflowCatalogOperationFault(error);
    }
  },
});

export const installWorkflowRevisionRestBinding: UnknownRestBinding = {
  method: 'POST',
  path: '/v1/registry/revisions',
  pathParamNames: [],
  operationName: 'weft.workflows.revisions.install',
  inputSources: {
    manifest: { kind: 'body-field', bodyField: 'manifest' },
  },
  extractInput: async (request, _pathParams, context) => {
    const body = await readWorkflowCatalogRestBody(request, context);
    return { manifest: body['manifest'] };
  },
  success: { kind: 'json', status: 201 },
};
