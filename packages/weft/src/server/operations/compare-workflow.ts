/**
 * `weft.workflows.compare` operation + REST binding (COR-2536): a fork aligned with its source,
 * step by step, one page at a time. The engine makes the alignment, so every client reads the same
 * answer; this file only maps the engine's refusals to faults.
 *
 * @module server/operations/compare-workflow
 */
import { z } from 'zod';

import { defineOperation, type OperationFault, type Principal } from "../../embedded/backchannel/src/index.ts";
import { invalidParamsFault, type UnknownRestBinding } from "../../embedded/backchannel/src/internals.ts";
import { CompareRequiresForkError } from '../../core/engine/compare-fork.ts';
import { WorkflowNotFoundError } from '../../core/engine/errors.ts';
import { CompareWindowError } from '../../core/engine/fork-timeline-alignment.ts';
import type { ForkComparison } from '../../core/types.ts';
import { assertOperationEngineMethods, unprocessableFault } from './operation-helpers.ts';

const compareWorkflowInput = z.object({
  workflowId: z.string().min(1).describe('Id of the fork to compare with its source.'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(1000)
    .optional()
    .describe('Steps in a page. Defaults to 100; at most 1000.'),
  cursor: z
    .string()
    .min(1)
    .optional()
    .describe('The nextCursor of the previous page; omit it for the first page.'),
});

const timelineStatus = z.enum(['running', 'completed', 'failed', 'cancelled', 'timed-out']);

const comparisonSide = z.object({
  operationType: z.string(),
  label: z.string(),
  status: timelineStatus,
  input: z.string(),
  output: z.string().exactOptional(),
});

const compareWorkflowOutput = z.object({
  workflowId: z.string(),
  sourceWorkflowId: z.string(),
  forkPoint: z.number(),
  steps: z.array(
    z.object({
      index: z.number(),
      shared: z.boolean(),
      source: comparisonSide.exactOptional(),
      fork: comparisonSide.exactOptional(),
    }),
  ),
  nextCursor: z.string().exactOptional(),
});

export type CompareWorkflowInput = z.infer<typeof compareWorkflowInput>;
export type CompareWorkflowOutput = ForkComparison;

/** Map an engine error `engine.compare` threw to the fault a caller reads. */
function resolveCompareFault(error: unknown): never {
  if (error instanceof WorkflowNotFoundError) {
    const fault: OperationFault = {
      code: 'NotFound',
      message: error.message,
      data: { resource: 'workflow', identifier: error.workflowId, weftCode: error.code },
    };
    throw fault;
  }
  // The message ends with the remediation, so a caller that shows only the message still says what to do.
  if (error instanceof CompareRequiresForkError) throw unprocessableFault(error.message);
  if (error instanceof CompareWindowError) throw invalidParamsFault(error.message);
  throw error;
}

/**
 * Decides whether a caller may read one workflow, beyond the `workflows:read` scope the catalog
 * already checks. `serve({ authorizeWorkflowRead })` supplies it; `weft.workflows.compare` asks it
 * for the fork and for its source, so a caller cleared for a fork cannot read the source through it.
 * Return `false` to deny; a throw is an internal error, never a denial.
 */
export type WorkflowReadAuthorizer = (context: {
  principal: Principal;
  workflowId: string;
}) => boolean | Promise<boolean>;

export type CompareWorkflowOperationOptions = Readonly<{
  authorizeWorkflowRead?: WorkflowReadAuthorizer | undefined;
}>;

/**
 * Build `weft.workflows.compare`. With `authorizeWorkflowRead`, the operation answers `NotFound`
 * (the same fault a missing fork gets) when the hook denies the fork or its source; without it the
 * `workflows:read` scope alone decides.
 */
export function createCompareWorkflowOperation(options: CompareWorkflowOperationOptions = {}) {
  const authorizeWorkflowRead = options.authorizeWorkflowRead;
  return defineOperation({
    name: 'weft.workflows.compare',
    mcpExposable: false,
    summary: 'Compare a fork with its source, step by step',
    description:
      'Take the id of a workflow made by `weft.workflows.fork` and return its source run, the fork ' +
      'point, and the two timelines aligned by durable step: for each step the operation type, ' +
      'label, status, input and output on each side. A step before the fork point is `shared` and ' +
      'carries the source entry on both sides. Payload fields are redacted as the timeline read ' +
      'redacts them. Pages by step (`limit`, 100 by default) with `nextCursor`. Read-only. Faults ' +
      'with NotFound when the fork or its source is not visible, and with Unprocessable, naming ' +
      'what to do, when the workflow is not a fork.',
    destructive: false,
    tags: ['Workflows'],
    inputSchema: compareWorkflowInput,
    outputSchema: compareWorkflowOutput,
    access: { kind: 'scoped', scopes: { kind: 'anyOf', scopes: ['workflows:read'] } },
    discoverable: true,
    producibleFaults: ['NotFound', 'Unprocessable'],
    transports: { http: true, jsonRpcHttp: true, jsonRpcWebSocket: true, jsonRpcStdio: true },
    unknownKeyPolicy: { http: 'strip', jsonRpc: 'reject' },
    invoke: async ({ input, host: engine, principal }): Promise<CompareWorkflowOutput> => {
      assertOperationEngineMethods(engine, ['compare']);
      try {
        if (authorizeWorkflowRead !== undefined) {
          await requireReadableForkAndSource(authorizeWorkflowRead, engine, principal, input);
        }
        return await engine.compare(input.workflowId, {
          ...(input.limit === undefined ? {} : { limit: input.limit }),
          ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
        });
      } catch (error) {
        return resolveCompareFault(error);
      }
    },
  });
}

/**
 * Ask the hook about the fork, then about its source, before the engine reads either timeline. A
 * denial of either throws the fork's own not-found error, so a refusal reads like a missing fork and
 * says nothing about the source. A fork that does not exist falls through to the engine, which
 * answers the same not-found.
 */
async function requireReadableForkAndSource(
  authorizeWorkflowRead: WorkflowReadAuthorizer,
  engine: unknown,
  principal: Principal,
  input: CompareWorkflowInput,
): Promise<void> {
  assertOperationEngineMethods(engine, ['get']);
  if (!(await authorizeWorkflowRead({ principal, workflowId: input.workflowId }))) {
    throw new WorkflowNotFoundError(input.workflowId);
  }
  const forkState = await engine.get(input.workflowId);
  const sourceWorkflowId = forkState?.forkedFrom?.workflowId;
  if (sourceWorkflowId === undefined) return;
  if (!(await authorizeWorkflowRead({ principal, workflowId: sourceWorkflowId }))) {
    throw new WorkflowNotFoundError(input.workflowId);
  }
}

export const compareWorkflowOperation = createCompareWorkflowOperation();

export const compareWorkflowRestBinding: UnknownRestBinding = {
  method: 'GET',
  path: '/v1/workflows/:id/compare',
  pathParamNames: ['id'],
  operationName: 'weft.workflows.compare',
  inputSources: {
    workflowId: { kind: 'path', pathParam: 'id' },
    limit: { kind: 'query', queryParam: 'limit' },
    cursor: { kind: 'query', queryParam: 'cursor' },
  },
  extractInput: async (request, pathParams) => {
    const query = new URL(request.url).searchParams;
    const limit = query.get('limit');
    const cursor = query.get('cursor');
    return {
      workflowId: pathParams['id'] ?? '',
      // A limit that is not a number is passed on as it came, for the schema to refuse.
      ...(limit === null ? {} : { limit: limit.trim() === '' ? limit : Number(limit) }),
      ...(cursor === null ? {} : { cursor }),
    };
  },
  success: { kind: 'json', status: 200 },
};
