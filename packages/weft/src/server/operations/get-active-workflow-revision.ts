/**
 * `weft.workflows.active.get` operation + REST binding.
 *
 * Returns the currently active revision pointer for one workflow name.
 * Named `active.get` rather than `revisions.getActive` — `OPERATION_NAME_PATTERN`
 * forbids camelCase wire segments, and `getActive` is only this namespace
 * method's TypeScript name (`engine.workflows.getActive`).
 *
 * In-memory only: matches `RegistrySnapshot.activeRevisions`' existing
 * staleness contract exactly (see `engine-workflows-namespace.ts`'s
 * `getActive` JSDoc), which is what makes "operations and the registry
 * snapshot agree" true by construction.
 *
 * @module server/operations/get-active-workflow-revision
 */

import { z } from 'zod';

import type { WorkflowCatalogActivePointer } from '../../core/catalog/index.ts';
import type { Engine } from '../../core/engine.ts';
import type { OperationFault } from '../operation-fault.ts';
import { defineOperation } from '../operation-registry.ts';
import type { UnknownRestBinding } from '../rest-bindings.ts';
import {
  validateWorkflowNameField,
  workflowsReadAccess,
} from './workflow-catalog-operation-helpers.ts';

const getActiveWorkflowRevisionInput = z.object({
  name: z.unknown().describe('Workflow name. Runtime validation requires a wire-safe identifier.'),
});
const getActiveWorkflowRevisionOutput = z.unknown();

export type GetActiveWorkflowRevisionInput = z.infer<typeof getActiveWorkflowRevisionInput>;
export type GetActiveWorkflowRevisionOutput = WorkflowCatalogActivePointer;

export const getActiveWorkflowRevisionOperation = defineOperation<
  GetActiveWorkflowRevisionInput,
  GetActiveWorkflowRevisionOutput
>({
  name: 'weft.workflows.active.get',
  mcpExposable: false,
  summary: 'Get the currently active revision pointer for a workflow',
  description:
    'Read the current `{ revision, generation, activatedAt }` active pointer for `name`. ' +
    "Read-only, in-memory (matches `RegistrySnapshot.activeRevisions`' staleness contract " +
    'exactly). Faults with NotFound when `name` has never been activated.',
  destructive: false,
  tags: ['Workflow Catalog'],
  inputSchema: getActiveWorkflowRevisionInput,
  outputSchema: getActiveWorkflowRevisionOutput as z.ZodType<GetActiveWorkflowRevisionOutput>,
  access: workflowsReadAccess,
  producibleFaults: ['NotFound', 'InvalidParams'],
  discoverable: true,
  transports: { http: true, jsonRpcHttp: true, jsonRpcWebSocket: true, jsonRpcStdio: true },
  unknownKeyPolicy: { http: 'strip', jsonRpc: 'reject' },
  invoke: async ({ input, engine }): Promise<GetActiveWorkflowRevisionOutput> => {
    const e = engine as Engine;
    const name = validateWorkflowNameField(input.name);
    const pointer = await e.workflows.getActive(name);
    if (pointer === null) {
      const fault: OperationFault = {
        code: 'NotFound',
        message: `Workflow "${name}" has never been activated`,
        data: { resource: 'workflow-active-revision', identifier: name },
      };
      throw fault;
    }
    return pointer;
  },
});

export const getActiveWorkflowRevisionRestBinding: UnknownRestBinding = {
  method: 'GET',
  path: '/v1/registry/workflows/:name/active',
  pathParamNames: ['name'],
  operationName: 'weft.workflows.active.get',
  inputSources: {
    name: { kind: 'path', pathParam: 'name' },
  },
  extractInput: async (_request, pathParams) => ({
    name: pathParams['name'] ?? '',
  }),
  success: { kind: 'json', status: 200 },
};
