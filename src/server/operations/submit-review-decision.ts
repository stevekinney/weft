import { z } from 'zod';

import type { Engine } from '../../core/engine.ts';
import type { ReviewDecision, SubmitReviewOptions } from '../../core/types.ts';
import type { OperationFault } from '../operation-fault.ts';
import { defineOperation } from '../operation-registry.ts';
import type { UnknownRestBinding } from '../rest-bindings.ts';
import { readRestJsonBody } from '../rest-body.ts';
import { isOperationFault } from './operation-helpers.ts';

const VALID_DECISIONS = [
  'approved',
  'rejected',
  'needs-changes',
] as const satisfies ReadonlyArray<ReviewDecision>;

const sectionDecisionsSchema = z.record(z.string(), z.enum(['approved', 'rejected']));

const submitReviewDecisionInput = z.object({
  reviewId: z.string().min(1),
  decision: z.unknown().optional(),
  reviewer: z.unknown().optional(),
  feedback: z.unknown().optional(),
  sectionDecisions: z.unknown().optional(),
  workflowId: z.unknown().optional(),
});
const submitReviewDecisionOutput = z.object({
  ok: z.literal(true),
});

export type SubmitReviewDecisionInput = z.infer<typeof submitReviewDecisionInput>;
export type SubmitReviewDecisionOutput = z.infer<typeof submitReviewDecisionOutput>;

type ValidatedReviewDecisionInput = {
  decision: ReviewDecision;
  reviewer: string;
  reviewOptions: SubmitReviewOptions;
};

/**
 * Validate and parse the `sectionDecisions` field for partial-approval review
 * decisions. Returns `undefined` when the field is absent. Throws an
 * `InvalidParams` fault when present but not a record of "approved"/"rejected".
 */
function parseSectionDecisions(sectionDecisions: unknown): SubmitReviewOptions['sectionDecisions'] {
  if (sectionDecisions === undefined) return undefined;

  const parsed = sectionDecisionsSchema.safeParse(sectionDecisions);
  if (!parsed.success) {
    const fault: OperationFault = {
      code: 'InvalidParams',
      message:
        'Field "sectionDecisions" must be a record mapping section names to "approved" or "rejected"',
      data: { issues: [] },
    };
    throw fault;
  }

  return parsed.data;
}

/**
 * Validate the review decision input fields in precedence order:
 *   1. decision + reviewer presence  — both must be strings
 *   2. decision value validity        — must be one of the allowed decisions
 *   3. feedback type                  — must be a string when provided
 *   4. sectionDecisions shape         — must be a record of "approved"|"rejected" when provided
 *
 * Returns the validated decision, reviewer, and the constructed `SubmitReviewOptions`.
 * Throws an `InvalidParams` fault on the first invalid field.
 */
function validateReviewDecisionInput(
  input: SubmitReviewDecisionInput,
): ValidatedReviewDecisionInput {
  if (typeof input.decision !== 'string' || typeof input.reviewer !== 'string') {
    const fault: OperationFault = {
      code: 'InvalidParams',
      message: 'Missing required fields: decision, reviewer',
      data: { issues: [] },
    };
    throw fault;
  }

  if (!VALID_DECISIONS.includes(input.decision as (typeof VALID_DECISIONS)[number])) {
    const fault: OperationFault = {
      code: 'InvalidParams',
      message: `Invalid decision "${input.decision}". Must be one of: ${VALID_DECISIONS.join(', ')}`,
      data: { issues: [] },
    };
    throw fault;
  }

  if (input.feedback !== undefined && typeof input.feedback !== 'string') {
    const fault: OperationFault = {
      code: 'InvalidParams',
      message: 'Field "feedback" must be a string when provided',
      data: { issues: [] },
    };
    throw fault;
  }

  const sectionDecisions = parseSectionDecisions(input.sectionDecisions);

  const decision = input.decision as ReviewDecision;
  const reviewer = input.reviewer;
  const reviewOptions: SubmitReviewOptions = { decision, reviewer };
  if (typeof input.feedback === 'string') {
    reviewOptions.feedback = input.feedback;
  }
  if (sectionDecisions !== undefined) {
    reviewOptions.sectionDecisions = sectionDecisions;
  }
  if (typeof input.workflowId === 'string') {
    reviewOptions.workflowId = input.workflowId;
  }

  return { decision, reviewer, reviewOptions };
}

/**
 * Map an engine error thrown by `engine.submitReview` to the canonical fault.
 *
 * Routing order:
 *   1. 'not found' → NotFound, resource: 'review'
 *   2. otherwise   → EngineFailure
 */
function mapReviewDecisionError(error: unknown, reviewId: string): never {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('not found')) {
    const fault: OperationFault = {
      code: 'NotFound',
      message,
      data: { resource: 'review', identifier: reviewId },
    };
    throw fault;
  }

  const fault: OperationFault = {
    code: 'EngineFailure',
    message,
    data: {},
  };
  throw fault;
}

export const submitReviewDecisionOperation = defineOperation<
  SubmitReviewDecisionInput,
  SubmitReviewDecisionOutput
>({
  name: 'weft.reviews.decision.submit',
  mcpExposable: false,
  summary: 'Submit a decision for a human review',
  description:
    'Submit an approve/reject (or option) decision for a pending human review, resuming the ' +
    'waiting workflow down the corresponding branch. The decision is final and cannot be ' +
    'retracted — the same finality as a signal. Faults with NotFound when the review is not ' +
    'visible.',
  // Submitting an approve/reject decision durably resumes the workflow down
  // the corresponding branch; the decision cannot be retracted. Same finality
  // as a signal, so it is destructive.
  destructive: true,
  tags: ['Reviews'],
  inputSchema: submitReviewDecisionInput,
  outputSchema: submitReviewDecisionOutput,
  access: { kind: 'public' },
  producibleFaults: ['NotFound'],
  transports: { http: true, jsonRpcHttp: true, jsonRpcWebSocket: true, jsonRpcStdio: true },
  unknownKeyPolicy: { http: 'strip', jsonRpc: 'reject' },
  invoke: async ({ input, engine }): Promise<SubmitReviewDecisionOutput> => {
    const e = engine as Engine;

    const { reviewOptions } = validateReviewDecisionInput(input);

    try {
      await e.submitReview(input.reviewId, reviewOptions);
      return { ok: true };
    } catch (error) {
      mapReviewDecisionError(error, input.reviewId);
    }
  },
});

export const submitReviewDecisionRestBinding: UnknownRestBinding = {
  method: 'POST',
  path: '/v1/reviews/:reviewId/decision',
  pathParamNames: ['reviewId'],
  operationName: 'weft.reviews.decision.submit',
  inputSources: {
    reviewId: { kind: 'path', pathParam: 'reviewId' },
    decision: { kind: 'body-field', bodyField: 'decision' },
    reviewer: { kind: 'body-field', bodyField: 'reviewer' },
    feedback: { kind: 'body-field', bodyField: 'feedback' },
    sectionDecisions: { kind: 'body-field', bodyField: 'sectionDecisions' },
    workflowId: { kind: 'body-field', bodyField: 'workflowId' },
  },
  extractInput: async (request, pathParams, context) => {
    const body = await readRestJsonBody(request, context).catch((error) => {
      if (isOperationFault(error)) throw error;
      throw new Error('Invalid JSON body');
    });
    const record: Record<string, unknown> =
      typeof body === 'object' && body !== null && !Array.isArray(body)
        ? (body as Record<string, unknown>)
        : {};

    return {
      reviewId: pathParams['reviewId'] ?? '',
      decision: record['decision'],
      reviewer: record['reviewer'],
      feedback: record['feedback'],
      sectionDecisions: record['sectionDecisions'],
      workflowId: record['workflowId'],
    };
  },
  success: { kind: 'json', status: 200 },
};
