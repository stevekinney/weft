import { z } from 'zod';

import { defineOperation } from "../../embedded/backchannel/src/index.ts";
import type { UnknownRestBinding } from "../../embedded/backchannel/src/internals.ts";
import type { WorkflowLogsResult } from '../../core/workflow-log-codec.ts';
import { assertOperationEngineMethods } from './operation-helpers.ts';

/**
 * A workflow's persisted `ctx.log` lines (COR-1811): the lines the run logged that its log store
 * still keeps, oldest first, and how many the per-run cap evicted. Reads what the engine's
 * `workflowLogs` store holds; an engine created without one lists nothing.
 */
const listWorkflowLogsInput = z.object({
  workflowId: z.string().min(1).describe('Id of the workflow whose log lines are listed.'),
  step: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe(
      'Narrow the lines to those logged before this durable step ran (the step index the workflow was about to run); omit it for every line.',
    ),
});

const workflowLogLineSchema = z
  .object({
    sequence: z.number().int().min(0),
    step: z.number().int().min(0).nullable(),
    level: z.enum(['debug', 'info', 'warn', 'error']),
    message: z.string(),
    timestamp: z.number(),
    workflowType: z.string(),
    attributes: z.record(z.string(), z.unknown()).optional(),
    truncated: z.boolean(),
  })
  .strict();

const listWorkflowLogsOutput = z
  .object({
    lines: z.array(workflowLogLineSchema),
    dropped: z.number().int().min(0),
  })
  .strict();

export type ListWorkflowLogsInput = z.infer<typeof listWorkflowLogsInput>;
export type ListWorkflowLogsOutput = WorkflowLogsResult;

export const listWorkflowLogsOperation = defineOperation({
  name: 'weft.workflows.logs.list',
  mcpExposable: false,
  summary: 'List the log lines a workflow wrote',
  description:
    'Read the `ctx.log` lines a workflow run wrote, oldest first, each with its sequence number, ' +
    'the durable step it was logged before (`null` for a line stored without one), level, ' +
    'message, timestamp, attributes, and whether it was cut. A run keeps its newest 500 lines ' +
    '(the host sets the cap): `dropped` counts the older lines the cap evicted or retention ' +
    'removed. A line holds at most 2 KiB, its message and attributes together: a long message is ' +
    'cut and ends in a truncation marker, and attributes that do not fit beside it are dropped ' +
    '(`truncated` is true either way). Attributes are redacted before they are stored: any value ' +
    'under a key that names a secret outright (`card`, `cvv`, `ssn`, `pin`, `password`, `secret`, ' +
    '`apiKey`, ...) is `[REDACTED]`, as is a string, object or array under a looser key (`token`, ' +
    '`session`, `auth`) and any bearer token, JSON Web Token or card number, while a number or ' +
    'boolean under a loose key (`inputTokens: 12`) is kept. The message is not redacted. Lines are kept with the run; once the run has finished they ' +
    "are pruned after the host's retention window, and a run that is still active keeps its " +
    'lines. A line is written asynchronously, so a crash can lose the last moments of a run. A ' +
    'workflow that is unknown, purged, or pruned lists no lines, and so does an engine that ' +
    'keeps none. Read-only.',
  destructive: false,
  tags: ['Logs'],
  inputSchema: listWorkflowLogsInput,
  outputSchema: listWorkflowLogsOutput,
  access: { kind: 'scoped', scopes: { kind: 'anyOf', scopes: ['workflows:read'] } },
  discoverable: true,
  producibleFaults: ['InvalidParams'],
  transports: { http: true, jsonRpcHttp: true, jsonRpcWebSocket: true, jsonRpcStdio: true },
  unknownKeyPolicy: { http: 'strip', jsonRpc: 'reject' },
  invoke: async ({ input, host: engine }): Promise<ListWorkflowLogsOutput> => {
    assertOperationEngineMethods(engine, ['getLogs']);
    return engine.getLogs(input.workflowId, { step: input.step });
  },
});

export const listWorkflowLogsRestBinding: UnknownRestBinding = {
  method: 'GET',
  path: '/v1/workflows/:id/logs',
  pathParamNames: ['id'],
  operationName: 'weft.workflows.logs.list',
  inputSources: {
    workflowId: { kind: 'path', pathParam: 'id' },
    step: { kind: 'query', queryParam: 'step' },
  },
  extractInput: async (request, pathParams) => {
    const step = new URL(request.url).searchParams.get('step');
    return {
      workflowId: pathParams['id'] ?? '',
      // Digits only: `Number()` would read an empty value as step 0 and `1e1` as step 10. Anything
      // else is NaN, which the input schema refuses as InvalidParams.
      ...(step === null ? {} : { step: /^\d+$/.test(step) ? Number(step) : Number.NaN }),
    };
  },
  success: { kind: 'json', status: 200 },
};
