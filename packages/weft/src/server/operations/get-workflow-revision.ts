/**
 * `weft.workflows.revisions.get` operation + REST binding.
 *
 * Returns one installed `(name, revision)` workflow catalog record.
 *
 * @module server/operations/get-workflow-revision
 */

import { z } from 'zod';

import type { WorkflowRevisionRecord } from '../../core/catalog/index.ts';
import type { Engine } from '../../core/engine.ts';
import type { OperationFault } from '../operation-fault.ts';
import { defineOperation } from '../operation-registry.ts';
import type { UnknownRestBinding } from '../rest-bindings.ts';
import {
  validateWorkflowNameField,
  validateWorkflowRevisionField,
  workflowsReadAccess,
} from './workflow-catalog-operation-helpers.ts';

const getWorkflowRevisionInput = z.object({
  name: z.unknown().describe('Workflow name. Runtime validation requires a wire-safe identifier.'),
  revision: z
    .unknown()
    .describe('Installed revision. Runtime validation requires a non-empty string.'),
});
const getWorkflowRevisionOutput = z.unknown();

export type GetWorkflowRevisionInput = z.infer<typeof getWorkflowRevisionInput>;
export type GetWorkflowRevisionOutput = WorkflowRevisionRecord;

export const getWorkflowRevisionOperation = defineOperation<
  GetWorkflowRevisionInput,
  GetWorkflowRevisionOutput
>({
  name: 'weft.workflows.revisions.get',
  mcpExposable: false,
  summary: 'Get one installed workflow revision',
  description:
    'Read one durably installed `(name, revision)` workflow catalog record. Read-only. Faults ' +
    'with NotFound when no such revision was installed.',
  destructive: false,
  tags: ['Workflow Catalog'],
  inputSchema: getWorkflowRevisionInput,
  outputSchema: getWorkflowRevisionOutput as z.ZodType<GetWorkflowRevisionOutput>,
  access: workflowsReadAccess,
  producibleFaults: ['NotFound', 'InvalidParams'],
  discoverable: true,
  transports: { http: true, jsonRpcHttp: true, jsonRpcWebSocket: true, jsonRpcStdio: true },
  unknownKeyPolicy: { http: 'strip', jsonRpc: 'reject' },
  invoke: async ({ input, engine }): Promise<GetWorkflowRevisionOutput> => {
    const e = engine as Engine;
    const name = validateWorkflowNameField(input.name);
    const revision = validateWorkflowRevisionField(input.revision);
    const record = await e.workflows.getRevision(name, revision);
    if (record === null) {
      const fault: OperationFault = {
        code: 'NotFound',
        message: `Workflow "${name}" has no installed revision "${revision}"`,
        data: { resource: 'workflow-revision', identifier: `${name}:${revision}` },
      };
      throw fault;
    }
    return record;
  },
});

export const getWorkflowRevisionRestBinding: UnknownRestBinding = {
  method: 'GET',
  path: '/v1/registry/workflows/:name/revisions/:revision',
  pathParamNames: ['name', 'revision'],
  operationName: 'weft.workflows.revisions.get',
  inputSources: {
    name: { kind: 'path', pathParam: 'name' },
    revision: { kind: 'path', pathParam: 'revision' },
  },
  extractInput: async (_request, pathParams) => ({
    name: pathParams['name'] ?? '',
    // Callers must percent-encode a `revision` value that itself contains a
    // `/` (e.g. a content-hash revision embedding one) — the router decodes
    // each path segment independently, so an UN-encoded `/` would be parsed
    // as an extra path segment rather than part of this value.
    revision: pathParams['revision'] ?? '',
  }),
  success: { kind: 'json', status: 200 },
};
