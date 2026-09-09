/**
 * `weft.workflows.revisions.preload` operation + REST binding.
 *
 * Loads, validates, and installs one dynamic workflow source revision
 * previously recorded via `engine.registerSource()` — a thin, documented
 * exposure of `engine.workflows.preload()` (WFT-15/16). Modeled on
 * `install-workflow-revision.ts` / `activate-workflow-revision.ts`.
 *
 * @module server/operations/preload-workflow-revision
 */

import { z } from 'zod';

import type { WorkflowRevisionRecord } from '../../core/catalog/index.ts';
import type { Engine } from '../../core/engine.ts';
import { isWeftError } from '../../core/weft-error.ts';
import type { OperationFault } from '../operation-fault.ts';
import { defineOperation } from '../operation-registry.ts';
import type { UnknownRestBinding } from '../rest-bindings.ts';
import {
  readWorkflowCatalogRestBody,
  throwWorkflowCatalogOperationFault,
  validateWorkflowNameField,
  validateWorkflowRevisionField,
  workflowsAdminAccess,
} from './workflow-catalog-operation-helpers.ts';

const preloadWorkflowRevisionInput = z.object({
  name: z.unknown().describe('Workflow name. Runtime validation requires a wire-safe identifier.'),
  revision: z
    .unknown()
    .describe(
      'The registerSource()-registered revision to load, validate, and install. Runtime ' +
        'validation requires a non-empty string.',
    ),
});
const preloadWorkflowRevisionOutput = z.unknown();

export type PreloadWorkflowRevisionInput = z.infer<typeof preloadWorkflowRevisionInput>;
export type PreloadWorkflowRevisionOutput = WorkflowRevisionRecord;

export const preloadWorkflowRevisionOperation = defineOperation<
  PreloadWorkflowRevisionInput,
  PreloadWorkflowRevisionOutput
>({
  name: 'weft.workflows.revisions.preload',
  mcpExposable: false,
  summary: 'Load, validate, and install a registered dynamic workflow source revision',
  description:
    'Load, validate, and install `(name, revision)` — previously recorded via ' +
    'engine.registerSource() — durably into the workflow catalog. Faults NotFound when no ' +
    'source was ever registered for this exact key, and Conflict when the load fails or the ' +
    'loaded module fails validation.',
  // Non-destructive, matching install-workflow-revision.ts: preloading adds
  // a new installed revision without moving the catalog active pointer or
  // affecting any running workflow's routing (unlike activate, which is
  // destructive).
  destructive: false,
  tags: ['Workflow Catalog'],
  inputSchema: preloadWorkflowRevisionInput,
  outputSchema: preloadWorkflowRevisionOutput as z.ZodType<PreloadWorkflowRevisionOutput>,
  access: workflowsAdminAccess,
  producibleFaults: ['InvalidParams', 'NotFound', 'Conflict'],
  discoverable: true,
  transports: { http: true, jsonRpcHttp: true, jsonRpcWebSocket: true, jsonRpcStdio: true },
  unknownKeyPolicy: { http: 'strip', jsonRpc: 'reject' },
  invoke: async ({ input, engine }): Promise<PreloadWorkflowRevisionOutput> => {
    const e = engine as Engine;
    const name = validateWorkflowNameField(input.name);
    const revision = validateWorkflowRevisionField(input.revision);

    try {
      return await e.workflows.preload(name, revision);
    } catch (error) {
      // `throwWorkflowCatalogOperationFault` classifies every typed Weft
      // error this family can produce; a raw, un-typed error reaching here
      // is the loader's OWN thrown exception (`resolveSourceModule()`
      // propagates it unwrapped) — a "the load fails" case this operation's
      // own contract promises Conflict for, same as a structurally-loaded
      // module that fails validation. Never forward the raw error's own
      // message onto the wire: a host loader can throw an error carrying a
      // filesystem path, a URL with embedded credentials, or another
      // internal detail, and this Conflict fault (unlike `EngineFailure`)
      // is NOT masked by the canonical `shapeRestFault` REST path — it
      // would otherwise land verbatim in the REST response body. The
      // underlying cause is still observable, in classified (not raw) form,
      // via `weft.catalog.diagnostics`' `source.lastFailureCategory` —
      // `engine.workflows.preload()` records it there before this catch
      // ever runs.
      if (!isWeftError(error)) {
        const fault: OperationFault = {
          code: 'Conflict',
          message: `Dynamic workflow source "${name}" revision "${revision}" failed to load.`,
          data: { reason: 'load-failed' },
        };
        throw fault;
      }
      return throwWorkflowCatalogOperationFault(error);
    }
  },
});

export const preloadWorkflowRevisionRestBinding: UnknownRestBinding = {
  method: 'POST',
  path: '/v1/registry/workflows/:name/preload',
  pathParamNames: ['name'],
  operationName: 'weft.workflows.revisions.preload',
  inputSources: {
    name: { kind: 'path', pathParam: 'name' },
    revision: { kind: 'body-field', bodyField: 'revision' },
  },
  extractInput: async (request, pathParams, context) => {
    const body = await readWorkflowCatalogRestBody(request, context);
    return {
      name: pathParams['name'] ?? '',
      revision: body['revision'],
    };
  },
  success: { kind: 'json', status: 200 },
};
