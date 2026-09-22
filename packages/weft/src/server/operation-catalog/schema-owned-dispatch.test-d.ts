import { z } from 'zod';
import { defineOperation } from '../operation-registry.ts';
import { createOperationRegistry } from './registry.ts';
import { catalogWorkflow } from './workflow-adapter.ts';
const base = {
  name: 'weft.review.contract',
  mcpExposable: false,
  summary: 'contract',
  destructive: false,
  access: { kind: 'public' as const },
  transports: { http: true, jsonRpcHttp: true, jsonRpcWebSocket: true, jsonRpcStdio: true },
  unknownKeyPolicy: { http: 'reject' as const, jsonRpc: 'reject' as const },
};
const subscription = defineOperation({
  ...base,
  kind: 'subscription',
  inputSchema: z.object({ value: z.string().transform((value) => value.length) }),
  outputSchema: z.object({ subscriptionId: z.string().default('generated') }),
  eventSchema: z.string().transform((value) => value.length),
  authorize: async ({ input }) => {
    const length: number = input.value;
    // @ts-expect-error Callback receives parsed input.
    const raw: string = input.value;
    void [length, raw];
    return { allowed: true };
  },
  invoke: async () => ({
    envelope: {},
    iterable: (async function* () {
      yield 'event';
    })(),
    close: async () => {},
  }),
});
const kind: 'subscription' = subscription.kind;
const parsedEnvelope: z.output<typeof subscription.outputSchema> = { subscriptionId: 'sub' };
// @ts-expect-error Defaulted output is required after parsing.
const missingDefault: z.output<typeof subscription.outputSchema> = {};
const event: z.output<typeof subscription.eventSchema> = 5;
// @ts-expect-error Parsed event is numeric.
const rawEvent: z.output<typeof subscription.eventSchema> = 'event';
// @ts-expect-error Subscription is never scalar.
const scalarResult: Awaited<ReturnType<typeof subscription.invoke>> = 'scalar';
// @ts-expect-error Subscription is never a bare iterable.
const iterableResult: Awaited<ReturnType<typeof subscription.invoke>> = (async function* () {
  yield 'event';
})();
// @ts-expect-error Subscription requires close.
const missingClose: Awaited<ReturnType<typeof subscription.invoke>> = {
  envelope: {},
  iterable: (async function* () {
    yield 'event';
  })(),
};
const noncallableClose: Awaited<ReturnType<typeof subscription.invoke>> = {
  envelope: {},
  iterable: (async function* () {
    yield 'event';
  })(),
  // @ts-expect-error Close must be callable.
  close: false,
};
const scalarStream = defineOperation({
  ...base,
  kind: 'stream',
  inputSchema: z.object({}),
  outputSchema: z.object({ chunks: z.array(z.string()) }),
  eventSchema: z.string(),
  invoke: async () => ({ chunks: ['event'] }),
});
const iterableStream = defineOperation({
  ...base,
  kind: 'stream',
  inputSchema: z.object({}),
  outputSchema: z.object({ chunks: z.array(z.string()) }),
  eventSchema: z.string(),
  invoke: async () =>
    (async function* () {
      yield 'event';
    })(),
});
const entry = createOperationRegistry([subscription, scalarStream, iterableStream]).get(
  subscription.name,
);
if (entry) {
  // @ts-expect-error Registry entries cannot expose raw invoke.
  void entry.invoke;
  // @ts-expect-error Registry entries cannot expose raw authorization.
  void entry.authorize;
}
const workflowOperation = catalogWorkflow({
  ...base,
  workflowType: 'contractWorkflow',
  inputSchema: z.object({
    value: z.string().transform((value) => value.length),
    label: z.string().default('ready'),
  }),
  authorize: async ({ input }) => {
    const length: number = input.value;
    const label: string = input.label;
    // @ts-expect-error Workflow authorization receives the transformed value.
    const raw: string = input.value;
    void [length, label, raw];
    return { allowed: true };
  },
});
const workflowRaw: z.input<typeof workflowOperation.inputSchema> = { value: 'input' };
const workflowParsed: z.output<typeof workflowOperation.inputSchema> = {
  value: 5,
  label: 'ready',
};
// @ts-expect-error The defaulted label is required after parsing.
const workflowMissingDefault: z.output<typeof workflowOperation.inputSchema> = { value: 5 };
// @ts-expect-error The public workflow schema retains its raw string input.
const workflowInvalidRaw: z.input<typeof workflowOperation.inputSchema> = { value: 5 };
void [
  kind,
  parsedEnvelope,
  missingDefault,
  event,
  rawEvent,
  scalarResult,
  iterableResult,
  missingClose,
  noncallableClose,
  workflowRaw,
  workflowParsed,
  workflowMissingDefault,
  workflowInvalidRaw,
];
