import { z } from 'zod';
import { assertOperationEngineMethods } from './operation-helpers.ts';

import { type OperationFault, defineOperation } from "../../embedded/backchannel/src/index.ts";
import type { UnknownRestBinding } from "../../embedded/backchannel/src/internals.ts";
import type { ReviewRequest } from '../../core/review/index.ts';

const getReviewInput = z.object({
  workflowId: z.string().min(1).describe('Id of the workflow the review belongs to.'),
  reviewId: z.string().min(1).describe('Id of the review request to read.'),
});
const getReviewOutput = z.unknown();

export type GetReviewInput = z.infer<typeof getReviewInput>;
export type GetReviewOutput = ReviewRequest;

export const getReviewOperation = defineOperation({
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
  outputSchema: getReviewOutput,
  access: { kind: 'scoped', scopes: { kind: 'anyOf', scopes: ['reviews:read'] } },
  discoverable: true,
  producibleFaults: ['NotFound'],
  transports: { http: true, jsonRpcHttp: true, jsonRpcWebSocket: true, jsonRpcStdio: true },
  unknownKeyPolicy: { http: 'strip', jsonRpc: 'reject' },
  invoke: async ({ input, host: engine }): Promise<GetReviewOutput> => {
    assertOperationEngineMethods(engine, ['getReview']);
    const e = engine;
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
};
