import type { ReviewDecision, ReviewDecisionRecord, SubmitReviewOptions } from '@lostgradient/weft';

const decision: ReviewDecision = 'needs-changes';
const options: SubmitReviewOptions = {
  decision,
  reviewer: 'ops@example.com',
};

const record: ReviewDecisionRecord = {
  reviewId: 'review-1',
  decision,
  reviewer: options.reviewer,
  timestamp: 1,
};

// @ts-expect-error the decision value union does not accept review records.
const invalidDecision: ReviewDecision = record;
// @ts-expect-error review records require durable review metadata.
const invalidRecord: ReviewDecisionRecord = decision;

void options;
void invalidDecision;
void invalidRecord;
void record;
