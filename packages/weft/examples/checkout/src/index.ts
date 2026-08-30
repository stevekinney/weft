import { Engine, activity, workflow } from '@lostgradient/weft';

export interface CheckoutItem {
  name: string;
  quantity: number;
  sku: string;
  unitPriceCents: number;
}

export interface CheckoutInput {
  customerEmail: string;
  items: CheckoutItem[];
  orderId: string;
}

export interface CheckoutResult {
  confirmationId: string;
  orderId: string;
  paymentId: string;
  reservationId: string;
  status: 'scheduled-for-shipment';
  totalCents: number;
  trackingNumber: string;
}

export function createCheckoutInput(orderId = 'checkout-example'): CheckoutInput {
  return {
    customerEmail: 'ada@example.com',
    items: [
      {
        name: 'Field notebook',
        quantity: 2,
        sku: 'notebook-field',
        unitPriceCents: 1200,
      },
      {
        name: 'Mechanical pencil',
        quantity: 1,
        sku: 'pencil-mechanical',
        unitPriceCents: 800,
      },
    ],
    orderId,
  };
}

export const sampleCheckoutInput: CheckoutInput = createCheckoutInput();

export function calculateTotalCents(items: CheckoutItem[]): number {
  return items.reduce((total, item) => total + item.quantity * item.unitPriceCents, 0);
}

export const chargePayment = activity({
  idempotent: true,
  name: 'chargePayment',
  execute: async (input: { orderId: string; totalCents: number }) => ({
    paymentId: `pay_${input.orderId}`,
    totalCents: input.totalCents,
  }),
});

export const reserveInventory = activity({
  idempotent: true,
  name: 'reserveInventory',
  execute: async (input: { items: CheckoutItem[]; orderId: string }) => ({
    itemCount: input.items.reduce((count, item) => count + item.quantity, 0),
    reservationId: `res_${input.orderId}`,
  }),
});

export const sendConfirmation = activity({
  idempotent: true,
  name: 'sendConfirmation',
  execute: async (input: { customerEmail: string; orderId: string; paymentId: string }) => ({
    confirmationId: `conf_${input.orderId}`,
    sentTo: input.customerEmail,
  }),
});

export const scheduleShipping = activity({
  idempotent: true,
  name: 'scheduleShipping',
  execute: async (input: { orderId: string; reservationId: string }) => ({
    carrier: 'ground',
    trackingNumber: `trk_${input.orderId}`,
  }),
});

export const checkoutWorkflow = workflow({ name: 'checkout' })
  .activities({
    chargePayment,
    reserveInventory,
    scheduleShipping,
    sendConfirmation,
  })
  .execute(async function* (
    context,
    input: CheckoutInput,
  ): AsyncGenerator<unknown, CheckoutResult> {
    const totalCents = calculateTotalCents(input.items);
    const payment = yield* context.run('chargePayment', {
      orderId: input.orderId,
      totalCents,
    });
    const reservation = yield* context.run('reserveInventory', {
      items: input.items,
      orderId: input.orderId,
    });
    const confirmation = yield* context.run('sendConfirmation', {
      customerEmail: input.customerEmail,
      orderId: input.orderId,
      paymentId: payment.paymentId,
    });
    const shipment = yield* context.run('scheduleShipping', {
      orderId: input.orderId,
      reservationId: reservation.reservationId,
    });

    return {
      confirmationId: confirmation.confirmationId,
      orderId: input.orderId,
      paymentId: payment.paymentId,
      reservationId: reservation.reservationId,
      status: 'scheduled-for-shipment',
      totalCents,
      trackingNumber: shipment.trackingNumber,
    };
  });

export async function runCheckoutExample(
  input: CheckoutInput = sampleCheckoutInput,
  databasePath = Bun.env['WEFT_CHECKOUT_DATABASE_PATH'] ?? './checkout.sqlite',
): Promise<CheckoutResult> {
  const { SQLiteStorage } = await import('@lostgradient/weft/storage/sqlite');
  using storage = new SQLiteStorage(databasePath);
  await using engine = new Engine({ storage }).register(checkoutWorkflow);
  await engine.recoverAll({ acknowledgeUnknownWorkflowTypes: true });

  const handle = await engine.start('checkout', input, { id: input.orderId });
  return await handle.result();
}

if (import.meta.main) {
  const result = await runCheckoutExample(createCheckoutInput(`checkout-${Date.now()}`));
  console.log(JSON.stringify(result, null, 2));
}
