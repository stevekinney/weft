import {
  Context,
  Engine,
  activity,
  constraint,
  query,
  schedule,
  searchAttribute,
  signal,
  update,
  workflow,
  type ContextOperationRequest,
  type WorkflowContext,
} from '../../index.ts';

declare const context: Context;
declare const engine: Engine;

function expectType<T>(value: T): void {
  void value;
}

const bareActivity = activity(async function double(input: number) {
  return input * 2;
});
expectType<Promise<number>>(bareActivity(2));

const metadataActivity = activity({
  name: 'formatGreeting',
  queue: 'messages',
  execute: async (input: { name: string }) => `Hello, ${input.name}`,
});
expectType<Promise<string>>(metadataActivity({ name: 'Ada' }));

const zeroInputActivity = activity({
  name: 'zeroInput',
  execute: async () => 'done',
});
expectType<Promise<string>>(zeroInputActivity());

const unknownInputActivity = activity(async function inspectUnknown(input: unknown) {
  return input;
});

context.run(metadataActivity, { name: 'Ada' });
context.run(zeroInputActivity);
context.run(unknownInputActivity, { inspected: true });
// @ts-expect-error ctx.run accepts one input value plus optional ActivityCallOptions.
context.run(metadataActivity, { name: 'Ada' }, { name: 'Grace' });
// @ts-expect-error unknown is still an input type and must be provided.
context.run(unknownInputActivity);

const checkoutWorkflow = workflow({ name: 'checkout' }).execute(async function* (
  _context: WorkflowContext,
  input: { orderId: string },
) {
  return input.orderId;
});

const metadataWorkflow = workflow({
  name: 'metadataCheckout',
  version: '1.0.0',
})
  .searchAttributes({
    customerId: { type: 'string' },
  })
  .execute(async function* (_context: WorkflowContext, input: { orderId: string }) {
    return input.orderId.length;
  });

engine.register(checkoutWorkflow);
engine.register(metadataWorkflow);

const approvalSignal = signal<{ approved: boolean }>('approval');
const approveUpdate = update<{ reviewer: string }, { accepted: boolean }>('approve');
const statusQuery = query<{ verbose: boolean }, { status: string }>('status');
const noInputStatusQuery = query<void, { status: string }>('statusSummary');

expectType<Generator<ContextOperationRequest, { approved: boolean }, unknown>>(
  context.waitForSignal(approvalSignal),
);

context.onUpdate(approveUpdate, (input) => ({ accepted: input.reviewer.length > 0 }));
context.onQuery(statusQuery, (input) => ({ status: input.verbose ? 'verbose' : 'compact' }));
context.onQuery(noInputStatusQuery, () => ({ status: 'ok' }));

const priority = searchAttribute('priority', 'number');
const customerId = searchAttribute('customerId', 'string');
const createdAt = searchAttribute('createdAt', { type: 'string', format: 'date-time' });
const tags = searchAttribute('tags', { type: 'array', items: { type: 'string' } });
context.setAttribute(priority, 5);
context.setAttribute(customerId, 'cust_123');
context.setAttribute(createdAt, new Date('2026-05-05T00:00:00.000Z'));
context.setAttribute(tags, ['new', 'priority']);
expectType<number | undefined>(context.getAttribute(priority));
expectType<string | undefined>(context.getAttribute(customerId));
expectType<Date | undefined>(context.getAttribute(createdAt));
expectType<string[] | undefined>(context.getAttribute(tags));
// @ts-expect-error searchAttribute handles carry their value type.
context.setAttribute(priority, 'high');
// @ts-expect-error searchAttribute ties the schema fragment to the handle value type.
context.setAttribute(createdAt, '2026-05-05T00:00:00.000Z');
// @ts-expect-error string array search attributes require an array value.
context.setAttribute(tags, 'new');
// @ts-expect-error value type is inferred from the schema, not a caller-supplied generic.
searchAttribute<number>('customerId', 'string');

engine.list({ attributes: [{ key: priority, value: 1 }] });
engine.list({ attributes: [{ key: customerId, value: ['cust_123', 'cust_456'] }] });
engine.list({ attributes: [{ key: tags, value: ['new', 'priority'] }] });
engine.list({ attributes: [{ key: createdAt, gt: new Date('2026-05-05T00:00:00.000Z') }] });
// @ts-expect-error typed attribute filters must match the handle value type.
engine.list({ attributes: [{ key: priority, value: 'wrong' }] });
// @ts-expect-error string-valued attributes do not support numeric range filters.
engine.list({ attributes: [{ key: customerId, gt: 10 }] });

const invariant = constraint({
  name: 'positiveBalance',
  scope: 'account',
  check: () => true,
  onViolation: 'fail',
});
void invariant;

const recurringCheckout = schedule({
  workflow: checkoutWorkflow,
  cron: '0 * * * *',
  input: { orderId: 'ord_123' },
  overlapPolicy: 'skip',
});
void recurringCheckout;
