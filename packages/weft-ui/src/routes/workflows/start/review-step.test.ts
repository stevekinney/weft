import { render } from '@testing-library/svelte';
import { describe, expect, test } from 'bun:test';

import { HttpClientError } from '@lostgradient/weft/client';

import ReviewStep from './review-step.svelte';
import { EMPTY_ADVANCED_START_OPTIONS } from './start-wizard-state.ts';

const BASE_PROPS = {
  type: 'order-processing',
  payload: { orderId: 'ord-1' },
  advanced: EMPTY_ADVANCED_START_OPTIONS,
  onBack: () => {},
  onSubmit: () => {},
};

describe('ReviewStep', () => {
  test('shows the workflow type and Start button in the idle state', async () => {
    const { getByText, getByRole } = render(ReviewStep, {
      props: { ...BASE_PROPS, submitState: { status: 'idle' } },
    });

    expect(getByText('order-processing')).not.toBeNull();
    expect(getByRole('button', { name: 'Start workflow' })).not.toBeNull();
  });

  test('disables the submit button while pending', async () => {
    const { getByRole } = render(ReviewStep, {
      props: { ...BASE_PROPS, submitState: { status: 'pending' } },
    });

    expect((getByRole('button', { name: 'Starting…' }) as HTMLButtonElement).disabled).toBe(true);
  });

  test('shows a success result with a link to the new run and hides the form', async () => {
    const { getByRole, queryByRole } = render(ReviewStep, {
      props: {
        ...BASE_PROPS,
        submitState: { status: 'success', workflowId: 'wf_4a9f1234567890abcdef2c10' },
      },
    });

    const link = getByRole('link', { name: 'View →' });
    expect(link.getAttribute('href')).toBe('/workflows/~wf_4a9f1234567890abcdef2c10');
    expect(queryByRole('button', { name: 'Start workflow' })).toBeNull();
  });

  test('shows the spent-idempotency-key explanation for that conflict shape', async () => {
    const { getByText } = render(ReviewStep, {
      props: {
        ...BASE_PROPS,
        submitState: {
          status: 'error',
          error: new HttpClientError(409, 'conflict'),
          isSpentIdempotencyKey: true,
        },
      },
    });

    expect(getByText(/already run and was purged/)).not.toBeNull();
  });

  test('shows the generic fault banner for a non-idempotency error', async () => {
    const { getByText } = render(ReviewStep, {
      props: {
        ...BASE_PROPS,
        submitState: {
          status: 'error',
          error: new HttpClientError(500, 'boom'),
          isSpentIdempotencyKey: false,
        },
      },
    });

    expect(getByText('Something went wrong')).not.toBeNull();
  });
});
