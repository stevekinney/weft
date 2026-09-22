import { z } from 'zod';
import { assertOperationEngineMethods } from './operation-helpers.ts';

import { reviewListEntrySchema } from '../../core/review/index.ts';
import type { ReviewListEntry, ReviewListFilter, ReviewStatus } from '../../core/types.ts';
import { shapeOperationFaultAsJson } from '../operation-fault.ts';
import { defineOperation } from '../operation-registry.ts';
import type { UnknownRestBinding } from '../rest-bindings.ts';

const reviewStatusSchema = z.enum(['pending', 'completed']) satisfies z.ZodType<ReviewStatus>;
const listReviewsInput = z.object({
  status: reviewStatusSchema.optional(),
  workflowId: z.string().min(1).optional(),
  reviewType: z.string().min(1).optional(),
});
const listReviewsOutput = z.object({
  items: z.array(reviewListEntrySchema),
});

export type ListReviewsInput = z.infer<typeof listReviewsInput>;
export type ListReviewsOutput = { items: ReviewListEntry[] };

export const listReviewsOperation = defineOperation({
  name: 'weft.reviews.list',
  mcpExposable: false,
  summary: 'List human review requests',
  description:
    'List pending human-in-the-loop review requests, optionally filtered by workflow. ' +
    'Read-only. Returns each review request with its prompt, options, and originating ' +
    'workflow so an operator or agent can decide on it via the review-decision operation.',
  destructive: false,
  tags: ['Reviews'],
  inputSchema: listReviewsInput,
  outputSchema: listReviewsOutput,
  access: { kind: 'scoped', scopes: { kind: 'anyOf', scopes: ['reviews:read'] } },
  transports: { http: true, jsonRpcHttp: true, jsonRpcWebSocket: true, jsonRpcStdio: true },
  unknownKeyPolicy: { http: 'strip', jsonRpc: 'reject' },
  invoke: async ({ input, engine }): Promise<ListReviewsOutput> => {
    assertOperationEngineMethods(engine, ['listReviews']);
    const e = engine;
    const filter: ReviewListFilter = {
      ...(input.status === undefined ? {} : { status: input.status }),
      ...(input.workflowId === undefined ? {} : { workflowId: input.workflowId }),
      ...(input.reviewType === undefined ? {} : { reviewType: input.reviewType }),
    };
    return { items: await e.listReviews(filter) };
  },
});

function extractListReviewsInput(request: Request) {
  const url = new URL(request.url);
  const filter: { status?: string; workflowId?: string; reviewType?: string } = {};

  const status = url.searchParams.get('status');
  if (status !== null) {
    filter.status = status;
  }

  const workflowId = url.searchParams.get('workflowId');
  if (workflowId !== null) {
    filter.workflowId = workflowId;
  }

  const reviewType = url.searchParams.get('reviewType');
  if (reviewType !== null) {
    filter.reviewType = reviewType;
  }

  return filter;
}

export const listReviewsRestBinding: UnknownRestBinding = {
  method: 'GET',
  path: '/v1/reviews',
  pathParamNames: [],
  operationName: 'weft.reviews.list',
  inputSources: {
    status: { kind: 'query', queryParam: 'status' },
    workflowId: { kind: 'query', queryParam: 'workflowId' },
    reviewType: { kind: 'query', queryParam: 'reviewType' },
  },
  extractInput: async (request) => extractListReviewsInput(request),
  success: { kind: 'json', status: 200 },
  shapeFault: shapeOperationFaultAsJson,
};
