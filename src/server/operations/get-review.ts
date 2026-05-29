import { z } from 'zod';

import type { Engine } from '../../core/engine.ts';
import type { ReviewRequest } from '../../core/review/index.ts';
import type { OperationFault } from '../operation-fault.ts';
import { defineOperation } from '../operation-registry.ts';
import type { UnknownRestBinding } from '../rest-bindings.ts';
import { shapeRestFault } from './operation-helpers.ts';

const getReviewInput = z.object({
  workflowId: z.string().min(1),
  reviewId: z.string().min(1),
});
const getReviewOutput = z.unknown();

export type GetReviewInput = z.infer<typeof getReviewInput>;
export type GetReviewOutput = ReviewRequest;

export const getReviewOperation = defineOperation<GetReviewInput, GetReviewOutput>({
  name: 'weft.reviews.get',
  mcpExposable: false,
  summary: 'Get a specific review for a workflow',
  description:
    'Read a single human review request for a workflow by its identifiers, including the ' +
    'review prompt, available options, and current decision state. Read-only. Faults with ' +
    'NotFound when the review is not visible.',
  destructive: false,
  tags: ['Reviews'],
  inputSchema: getReviewInput,
  outputSchema: getReviewOutput as z.ZodType<GetReviewOutput>,
  access: { kind: 'public' },
  producibleFaults: ['NotFound'],
  transports: { http: true, jsonRpcHttp: true, jsonRpcWebSocket: true, jsonRpcStdio: true },
  unknownKeyPolicy: { http: 'strip', jsonRpc: 'reject' },
  invoke: async ({ input, engine }): Promise<GetReviewOutput> => {
    const e = engine as Engine;
    const review = await e.getReview(input.workflowId, input.reviewId);
    if (review === null) {
      const fault: OperationFault = {
        code: 'NotFound',
        message: `Review "${input.reviewId}" not found for workflow "${input.workflowId}"`,
        data: { resource: 'review', identifier: input.reviewId },
      };
      throw fault;
    }

    return review;
  },
});

function shapeGetReviewSuccess(result: GetReviewOutput): Response {
  return new Response(JSON.stringify(result), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function shapeGetReviewFault(fault: OperationFault): Response {
  return shapeRestFault(fault);
}

export const getReviewRestBinding: UnknownRestBinding = {
  method: 'GET',
  path: '/v1/workflows/:id/review/:reviewId',
  pathParamNames: ['id', 'reviewId'],
  operationName: 'weft.reviews.get',
  inputSources: {
    workflowId: { kind: 'path', pathParam: 'id' },
    reviewId: { kind: 'path', pathParam: 'reviewId' },
  },
  extractInput: async (_request, pathParams) => ({
    workflowId: pathParams['id'] ?? '',
    reviewId: pathParams['reviewId'] ?? '',
  }),
  success: { kind: 'json', status: 200 },
  shapeSuccess: (output: GetReviewOutput) => shapeGetReviewSuccess(output),
  shapeFault: shapeGetReviewFault,
};
