import { afterEach } from 'bun:test';
import { z } from 'zod';

import { Engine } from '../../core/engine.ts';
import type { DefinitionSchema, WorkflowContext, WorkflowDefinition } from '../../core/types.ts';
import { workflow } from '../../core/types.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { catalogWorkflow } from './workflow-adapter.ts';

function emptyAsyncIterable<T>(): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator]: () => ({
      next: async () => ({ done: true as const, value: undefined }),
    }),
  };
}

/** A test fixture shape for a registration metadata bag: a `WorkflowDefinition`
 * minus its `name` (the adapter supplies the name separately). */
export type WorkflowRegistrationFixture<TInput, TOutput> = Omit<
  WorkflowDefinition<TInput, TOutput>,
  'name'
>;

export const checkoutWorkflow = workflow({ name: 'checkout' }).execute(async function* (
  _context: WorkflowContext,
  input: unknown,
) {
  yield* emptyAsyncIterable();
  return { completed: true, input };
});
export const looseWorkflowWorkflow = workflow({ name: 'loose-workflow' }).execute(async function* (
  _context: WorkflowContext,
  input: unknown,
) {
  yield* emptyAsyncIterable();
  return input;
});

export type CheckoutInput = {
  orderId: string;
  amount: number;
};

export type StartHandle = {
  workflowId: string;
  status: string;
};

export const startHandleSchema = z.object({ workflowId: z.string(), status: z.string() });

export function parsedStartHandle(value: unknown): StartHandle {
  return startHandleSchema.parse(value);
}

export const checkoutInputSchema = z.object({
  orderId: z.string(),
  amount: z.number(),
});

export const catalogTransports = {
  http: true,
  jsonRpcHttp: true,
  jsonRpcWebSocket: true,
  jsonRpcStdio: true,
};

export const catalogUnknownKeyPolicy = {
  http: 'strip',
  jsonRpc: 'reject',
} as const;

const engines: Engine[] = [];

afterEach(() => {
  while (engines.length > 0) {
    engines.pop()?.[Symbol.dispose]();
  }
});

export function createEngine(): Engine {
  const engine = new Engine({ storage: new MemoryStorage() });
  engines.push(engine);
  return engine;
}

export function registerCheckoutWorkflow(engine: Engine): void {
  engine.register(checkoutWorkflow);
}

export function checkoutWorkflowRegistration() {
  const registration = {
    description: 'Start checkout from registration metadata',
    tags: ['Registration', 'Checkout'],
    inputSchema: checkoutInputSchema,
    handler: async function* (_context: WorkflowContext) {
      yield* emptyAsyncIterable();
      return { completed: true };
    },
  } satisfies WorkflowRegistrationFixture<CheckoutInput, { completed: true }>;
  return registration;
}

export function makeDefinitionSchema<TOutput>(): DefinitionSchema<unknown, TOutput> {
  return {
    '~standard': {
      version: 1,
      vendor: 'weft-test',
      validate: () => ({ issues: [{ message: 'unsupported test schema' }] }),
    },
  };
}

export function catalogCheckoutWorkflow() {
  return catalogWorkflow({
    name: 'weft.workflows.checkout.start',
    mcpExposable: false,
    workflowType: 'checkout',
    summary: 'Start a checkout workflow',
    tags: ['Workflows', 'Checkout'],
    inputSchema: checkoutInputSchema,
    access: { kind: 'public' },
    transports: catalogTransports,
    unknownKeyPolicy: catalogUnknownKeyPolicy,
  });
}
