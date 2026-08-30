import { encode } from '../core/codec.ts';
import type { Storage } from '../storage/interface.ts';

export async function storeHistoricalReviewDecisionWithoutRequestMetadata(
  storage: Storage,
): Promise<void> {
  // Historical fixture shape: older runtimes could persist decision-only records
  // without review metadata, and listReviews({ status: 'completed' }) skips them.
  await storage.put(
    'review-decision:historical-review',
    encode({
      reviewId: 'historical-review',
      decision: 'approved',
      reviewer: 'historical-reviewer',
      feedback: 'stored by an older runtime',
      timestamp: 9_000,
    }),
  );
}
