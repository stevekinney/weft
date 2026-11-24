import { z } from 'zod';

import { defineOperation } from "../../embedded/backchannel/src/index.ts";
import type { UnknownRestBinding } from "../../embedded/backchannel/src/internals.ts";
import {
  DEFAULT_UPDATE_HISTORY_LIMIT,
  isUpdateHistoryCursor,
  MAX_UPDATE_HISTORY_LIMIT,
  type UpdateHistoryPage,
} from '../../core/update-history.ts';
import { assertOperationEngineMethods } from './operation-helpers.ts';

/**
 * A workflow's update history (COR-1463): the updates it received through the durable request
 * path, newest first, each with the outcome the answer recorded. It lists no payload and no result;
 * a result is read through `weft.updates.result.get` while it is kept (five minutes after the
 * answer), and the outcome and failure message here outlive that.
 */
const listWorkflowUpdatesInput = z.object({
  workflowId: z.string().min(1).describe('Id of the workflow whose update history is listed.'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_UPDATE_HISTORY_LIMIT)
    .default(DEFAULT_UPDATE_HISTORY_LIMIT)
    .describe('Maximum number of updates to return per page, 1 to 200; defaults to 50.'),
  cursor: z
    .string()
    .max(160)
    .refine(isUpdateHistoryCursor, { message: 'Invalid cursor' })
    .optional()
    .describe(
      'The nextCursor of the previous page, to read the next page; omit it for the first page.',
    ),
});

const updateHistoryEntrySchema = z
  .object({
    updateId: z.string(),
    name: z.string(),
    receivedAt: z.number(),
    outcome: z.enum(['pending', 'completed', 'failed']),
    completedAt: z.number().optional(),
    error: z.string().optional(),
  })
  .strict();

const listWorkflowUpdatesOutput = z
  .object({
    items: z.array(updateHistoryEntrySchema),
    nextCursor: z.string().optional(),
  })
  .strict();

export type ListWorkflowUpdatesInput = z.infer<typeof listWorkflowUpdatesInput>;
export type ListWorkflowUpdatesOutput = UpdateHistoryPage;

export const listWorkflowUpdatesOperation = defineOperation({
  name: 'weft.workflows.updates.list',
  mcpExposable: false,
  summary: 'List the updates a workflow has received',
  description:
    'Read a bounded page of the updates a workflow has received through the durable request ' +
    'path, newest first. Each entry has the update id, its name, when it was received, and its ' +
    'outcome (`pending`, `completed`, or `failed` with the failure message). A result is not ' +
    'listed: read it with `weft.updates.result.get` while it is kept. The history is kept until ' +
    'the workflow is purged. The cursor is opaque; a workflow that is unknown or purged lists no ' +
    'entries. An update is recorded when it is queued as a durable request: every update sent ' +
    'with `weft.workflows.update` (REST and JSON-RPC) and `engine.submitCoordinatedUpdate()`. ' +
    'It is not recorded when it is served without a request: the MCP `update_workflow` tool, and ' +
    'an in-process `engine.update()` or `handle.update()` answered by a live handler or a parked ' +
    'waiter, mint an id and write no entry.',
  destructive: false,
  tags: ['Updates'],
  inputSchema: listWorkflowUpdatesInput,
  outputSchema: listWorkflowUpdatesOutput,
  access: { kind: 'scoped', scopes: { kind: 'anyOf', scopes: ['workflows:read'] } },
  discoverable: true,
  producibleFaults: ['InvalidParams'],
  transports: { http: true, jsonRpcHttp: true, jsonRpcWebSocket: true, jsonRpcStdio: true },
  unknownKeyPolicy: { http: 'strip', jsonRpc: 'reject' },
  invoke: async ({ input, host: engine }): Promise<ListWorkflowUpdatesOutput> => {
    assertOperationEngineMethods(engine, ['listUpdateHistory']);
    const liveEngine = engine;
    return liveEngine.listUpdateHistory(input.workflowId, {
      limit: input.limit,
      ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
    });
  },
});

export const listWorkflowUpdatesRestBinding: UnknownRestBinding = {
  method: 'GET',
  path: '/v1/workflows/:id/updates',
  pathParamNames: ['id'],
  operationName: 'weft.workflows.updates.list',
  inputSources: {
    workflowId: { kind: 'path', pathParam: 'id' },
    limit: { kind: 'query', queryParam: 'limit' },
    cursor: { kind: 'query', queryParam: 'cursor' },
  },
  extractInput: async (request, pathParams) => {
    const search = new URL(request.url).searchParams;
    const limit = search.get('limit');
    const cursor = search.get('cursor');
    return {
      workflowId: pathParams['id'] ?? '',
      ...(limit === null ? {} : { limit: Number(limit) }),
      ...(cursor === null ? {} : { cursor }),
    };
  },
  success: { kind: 'json', status: 200 },
};
