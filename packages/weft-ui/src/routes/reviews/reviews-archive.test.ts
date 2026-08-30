/**
 * Component tests for `ReviewsArchive` (plan §9.5, Track D — Appendix B
 * "… / archive"). Fakes the `createQuery` store contract directly (a plain
 * object with `subscribe`) rather than booting TanStack Query — this
 * component only reads `.data`/`.isPending` off the store.
 */
import { fireEvent, render } from '@testing-library/svelte';
import { describe, expect, test } from 'bun:test';

import type { CompletedReviewEntry, ReviewListEntry } from '@lostgradient/weft';
import { HttpClientError } from '@lostgradient/weft/client';

import type { CreateQueryResult } from '@tanstack/svelte-query';

import ReviewsArchive from './reviews-archive.svelte';

interface FakeQueryState<T> {
  data?: T;
  isPending: boolean;
  isError?: boolean;
  error?: unknown;
  refetch?: () => void;
}

function fakeQuery(state: FakeQueryState<ReviewListEntry[]>): CreateQueryResult<ReviewListEntry[]> {
  return {
    subscribe: (run: (state: FakeQueryState<ReviewListEntry[]>) => void) => {
      run(state);
      return () => {};
    },
  } as unknown as CreateQueryResult<ReviewListEntry[]>;
}

const entry: CompletedReviewEntry = {
  status: 'completed',
  reviewId: 'review-1',
  workflowId: 'wf_aa129f0c1234567890abcdef',
  artifact: {},
  reviewType: 'Contract approval',
  reviewers: ['ops@example.com'],
  allowPartial: false,
  createdAt: Date.now() - 120_000,
  decision: 'approved',
  reviewer: 'Avery Diaz',
  timestamp: Date.now() - 30_000,
};

describe('ReviewsArchive', () => {
  test('shows a loading skeleton while pending', async () => {
    const { container } = render(ReviewsArchive, {
      props: { completedQuery: fakeQuery({ isPending: true }) },
    });

    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
  });

  test('shows a fault banner instead of a false empty state when the query errors', async () => {
    let refetched = false;
    const { getByText, queryByText, getByRole } = render(ReviewsArchive, {
      props: {
        completedQuery: fakeQuery({
          isPending: false,
          isError: true,
          error: new HttpClientError(401, 'authentication required'),
          refetch: () => {
            refetched = true;
          },
        }),
      },
    });

    expect(getByText('Not authorized')).not.toBeNull();
    expect(queryByText('No decisions yet')).toBeNull();
    await fireEvent.click(getByRole('button', { name: 'Retry' }));
    expect(refetched).toBe(true);
  });

  test('shows an empty state with no completed reviews', async () => {
    const { getByText } = render(ReviewsArchive, {
      props: { completedQuery: fakeQuery({ data: [], isPending: false }) },
    });

    expect(getByText('No decisions yet')).not.toBeNull();
  });

  test('renders a row per completed review, read-only (no buttons)', async () => {
    const { getByText, queryAllByRole } = render(ReviewsArchive, {
      props: { completedQuery: fakeQuery({ data: [entry], isPending: false }) },
    });

    expect(getByText('Approved')).not.toBeNull();
    expect(getByText('Contract approval')).not.toBeNull();
    expect(getByText('Avery Diaz')).not.toBeNull();
    expect(getByText('wf_aa129…cdef')).not.toBeNull();
    expect(queryAllByRole('button')).toEqual([]);
  });
});
