import { z } from 'zod';

import type { Engine } from '../../core/engine.ts';
import { reviewListEntrySchema } from '../../core/review/index.ts';
import type { ReviewListEntry, ReviewListFilter, ReviewStatus } from '../../core/types.ts';
import { shapeOperationFaultAsJson } from '../operation-fault.ts';
import { defineOperation } from '../operation-registry.ts';
import type { UnknownRestBinding } from '../rest-bindings.ts';

const reviewStatusSchema = z.enum(['pending', 'completed']) as z.ZodType<ReviewStatus>;
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

export const listReviewsOperation = defineOperation<ListReviewsInput, ListReviewsOutput>({
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
  outputSchema: listReviewsOutput as z.ZodType<ListReviewsOutput>,
  access: { kind: 'scoped', scopes: { kind: 'anyOf', scopes: ['reviews:read'] } },
  transports: { http: true, jsonRpcHttp: true, jsonRpcWebSocket: true, jsonRpcStdio: true },
  unknownKeyPolicy: { http: 'strip', jsonRpc: 'reject' },
  invoke: async ({ input, engine }): Promise<ListReviewsOutput> => {
    const e = engine as Engine;
    return { items: await e.listReviews(input as ReviewListFilter) };
  },
});

function extractListReviewsInput(request: Request): ListReviewsInput {
  const url = new URL(request.url);
  const filter: ListReviewsInput = {};

  const status = url.searchParams.get('status');
  if (status !== null) {
    filter.status = status as ReviewStatus;
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
