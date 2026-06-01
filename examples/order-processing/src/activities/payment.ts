import { activity } from '@lostgradient/weft';

import type { ChargePaymentInput, PaymentCharge, RefundPaymentInput } from '../model';

export const chargePayment = activity({
  name: 'orderProcessingChargePayment',
  idempotent: true,
  timeout: '15s',
  retry: {
    backoffMultiplier: 2,
    initialBackoff: '250ms',
    maxAttempts: 4,
    maxBackoff: '5s',
    nonRetryableErrors: ['CardDeclinedError'],
  },
  execute: async (input: ChargePaymentInput): Promise<PaymentCharge> => {
    return {
      amount: input.amount,
      chargeId: `ch_${input.idempotencyKey}`,
    };
  },
});

export const refundPayment = activity({
  name: 'orderProcessingRefundPayment',
  idempotent: true,
  timeout: '15s',
  retry: {
    backoffMultiplier: 2,
    initialBackoff: '250ms',
    maxAttempts: 4,
    maxBackoff: '5s',
  },
  execute: async (input: RefundPaymentInput): Promise<string> => {
    return `refund_${input.chargeId}_${input.orderId}`;
  },
});
