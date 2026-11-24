/**
 * `weft.workflows.refresh.diagnostics` operation + REST binding.
 *
 * Reads the state of every registered workflow refresh source: what the last
 * check found, the candidate artifact next to the revision that is active
 * now, and, while opt-in polling runs, its policy, backoff, and next check.
 * A thin exposure of `engine.workflows.refreshStatus()` joined with the
 * catalog's active pointer.
 *
 * It reports the host's last failure as a bounded `reason`, never its own
 * message, which can name a path or a credentialed URL. A source registered
 * but never checked reads `idle`. Registering a source is not an operation;
 * see `refresh-workflow.ts`.
 *
 * @module server/operations/get-refresh-diagnostics
 */

import { z } from 'zod';

import { defineOperation } from "../../embedded/backchannel/src/index.ts";
import type { UnknownRestBinding } from "../../embedded/backchannel/src/internals.ts";
import type {
  WorkflowRefreshDiagnostics,
  WorkflowRefreshStatus,
} from '../../core/catalog/index.ts';
import type { Engine } from '../../core/engine.ts';
import { assertOperationWorkflowMethods } from './operation-helpers.ts';
import {
  validateWorkflowNameField,
  workflowsReadAccess,
} from './workflow-catalog-operation-helpers.ts';

const getRefreshDiagnosticsInput = z.object({
  name: z
    .unknown()
    .optional()
    .describe('Limit the answer to one workflow name. Omit it for every registered source.'),
});

const failureReasonSchema = z.enum([
  'not-registered',
  'source',
  'integrity',
  'identity',
  'contract',
  'runtime',
  'warming',
  'conflict',
  'cancelled',
  'stopped',
  'internal',
]);

const refreshSourceSchema = z
  .object({
    name: z.string(),
    state: z.enum([
      'idle',
      'checking',
      'not-modified',
      'warming',
      'activated',
      'installed',
      'failed',
    ]),
    etag: z.string().optional(),
    checkedAt: z.number().nonnegative().optional(),
    generation: z.number().int().nonnegative().optional(),
    reason: failureReasonSchema.optional(),
    candidate: z
      .object({ revision: z.string(), digest: z.string(), contractHash: z.string() })
      .strict()
      .optional(),
    current: z
      .object({
        revision: z.string(),
        generation: z.number().int().nonnegative(),
        contractHash: z.string().optional(),
        digest: z.string().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

const getRefreshDiagnosticsOutput = z
  .object({
    polling: z
      .object({
        intervalMilliseconds: z.number().positive(),
        maxBackoffMilliseconds: z.number().positive(),
        backoffMilliseconds: z.number().positive(),
        nextCheckAt: z.number().nonnegative().optional(),
      })
      .strict()
      .optional(),
    sources: z.array(refreshSourceSchema),
  })
  .strict();

export type GetRefreshDiagnosticsInput = z.infer<typeof getRefreshDiagnosticsInput>;
export type GetRefreshDiagnosticsOutput = z.infer<typeof getRefreshDiagnosticsOutput>;
type RefreshSourceOutput = z.infer<typeof refreshSourceSchema>;

function candidateOf(
  diagnostics: WorkflowRefreshDiagnostics,
): RefreshSourceOutput['candidate'] | undefined {
  const { revision, digest, contractHash } = diagnostics;
  return revision === undefined || digest === undefined || contractHash === undefined
    ? undefined
    : { revision, digest, contractHash };
}

type RefreshWorkflows = Pick<Engine['workflows'], 'refreshStatus' | 'getActive' | 'getRevision'>;

/** What is active now for `diagnostics.name`, with the digest only when refresh activated that revision. */
async function currentOf(
  workflows: RefreshWorkflows,
  diagnostics: WorkflowRefreshDiagnostics,
): Promise<RefreshSourceOutput['current'] | undefined> {
  const active = await workflows.getActive(diagnostics.name);
  if (active === null) return undefined;
  const record = await workflows.getRevision(diagnostics.name, active.revision);
  const activatedHere =
    diagnostics.activatedRevision === active.revision && diagnostics.activatedDigest !== undefined;
  return {
    revision: active.revision,
    generation: active.generation,
    ...(record === null ? {} : { contractHash: record.manifest.contractHash }),
    ...(activatedHere ? { digest: diagnostics.activatedDigest } : {}),
  };
}

async function sourceOf(
  workflows: RefreshWorkflows,
  diagnostics: WorkflowRefreshDiagnostics,
): Promise<RefreshSourceOutput> {
  const candidate = candidateOf(diagnostics);
  const current = await currentOf(workflows, diagnostics);
  return {
    name: diagnostics.name,
    state: diagnostics.state,
    ...(diagnostics.etag === undefined ? {} : { etag: diagnostics.etag }),
    ...(diagnostics.checkedAt === undefined ? {} : { checkedAt: diagnostics.checkedAt }),
    ...(diagnostics.generation === undefined ? {} : { generation: diagnostics.generation }),
    ...(diagnostics.reason === undefined ? {} : { reason: diagnostics.reason }),
    ...(candidate === undefined ? {} : { candidate }),
    ...(current === undefined ? {} : { current }),
  };
}

function pollingOf(
  polling: WorkflowRefreshStatus['polling'],
): Pick<GetRefreshDiagnosticsOutput, 'polling'> {
  if (polling === undefined) return {};
  const { nextCheckAt, ...policy } = polling;
  return { polling: { ...policy, ...(nextCheckAt === undefined ? {} : { nextCheckAt }) } };
}

export const getRefreshDiagnosticsOperation = defineOperation({
  name: 'weft.workflows.refresh.diagnostics',
  mcpExposable: false,
  summary: 'Read the state of every workflow refresh source',
  description:
    "Read each registered refresh source's last check (`idle` until first checked), its " +
    'candidate artifact next to the currently active revision, the last failure as a bounded ' +
    '`reason`, and, only while opt-in polling runs, the polling policy, backoff, and next check. ' +
    'Read-only. Without polling, checks are manual and `polling` is absent.',
  destructive: false,
  tags: ['Workflow Catalog'],
  inputSchema: getRefreshDiagnosticsInput,
  outputSchema: getRefreshDiagnosticsOutput,
  access: workflowsReadAccess,
  producibleFaults: ['InvalidParams'],
  discoverable: true,
  transports: { http: true, jsonRpcHttp: true, jsonRpcWebSocket: true, jsonRpcStdio: true },
  unknownKeyPolicy: { http: 'strip', jsonRpc: 'reject' },
  invoke: async ({ input, host: engine }): Promise<GetRefreshDiagnosticsOutput> => {
    assertOperationWorkflowMethods(engine, ['refreshStatus', 'getActive', 'getRevision']);
    const only = input.name === undefined ? undefined : validateWorkflowNameField(input.name);
    const status = engine.workflows.refreshStatus();

    const sources: RefreshSourceOutput[] = [];
    for (const diagnostics of status.sources) {
      if (only === undefined || diagnostics.name === only) {
        sources.push(await sourceOf(engine.workflows, diagnostics));
      }
    }
    return { ...pollingOf(status.polling), sources };
  },
});

export const getRefreshDiagnosticsRestBinding: UnknownRestBinding = {
  method: 'GET',
  path: '/v1/registry/refresh-diagnostics',
  pathParamNames: [],
  operationName: 'weft.workflows.refresh.diagnostics',
  inputSources: {
    name: { kind: 'query', queryParam: 'name' },
  },
  extractInput: async (request) => {
    const name = new URL(request.url).searchParams.get('name');
    return name === null ? {} : { name };
  },
  success: { kind: 'json', status: 200 },
};
