import { afterEach, describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { Engine } from '../../core/engine.ts';
import {
  WorkflowAlreadyExistsError,
  WorkflowNotRegisteredError,
} from '../../core/engine/errors.ts';
import { StartWorkflowValidationError } from '../../core/start-workflow-validation.ts';
import type { DefinitionSchema, WorkflowContext, WorkflowDefinition } from '../../core/types.ts';
import { workflow } from '../../core/types.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { generateOpenRpcDocument } from '../openrpc.ts';
import { anonymousPrincipal, principalFromApiKey } from '../principal.ts';
import { createOperationRegistry, executeOperation } from './index.ts';
import { catalogWorkflow } from './workflow-adapter.ts';

/** Local alias for the legacy `WorkflowRegistration` shape — name-less form
 * still used by these tests to construct registration metadata bags. */
type WorkflowRegistration<TInput, TOutput> = Omit<WorkflowDefinition<TInput, TOutput>, 'name'>;

const checkoutWorkflow = workflow({ name: 'checkout' }).execute(async function* (
  _context: WorkflowContext,
  input: unknown,
) {
  return { completed: true, input };
});
const looseWorkflowWorkflow = workflow({ name: 'loose-workflow' }).execute(async function* (
  _context: WorkflowContext,
  input: unknown,
) {
  return input;
});

type CheckoutInput = {
  orderId: string;
  amount: number;
};

type StartHandle = {
  workflowId: string;
  status: string;
};

const checkoutInputSchema = z.object({
  orderId: z.string(),
  amount: z.number(),
});

const catalogTransports = {
  http: true,
  jsonRpcHttp: true,
  jsonRpcWebSocket: true,
  jsonRpcStdio: true,
};

const catalogUnknownKeyPolicy = {
  http: 'strip',
  jsonRpc: 'reject',
} as const;

const engines: Engine[] = [];

afterEach(() => {
  while (engines.length > 0) {
    engines.pop()?.[Symbol.dispose]();
  }
});

function createEngine(): Engine {
  const engine = new Engine({ storage: new MemoryStorage() });
  engines.push(engine);
  return engine;
}

function registerCheckoutWorkflow(engine: Engine): void {
  engine.register(checkoutWorkflow);
}

function checkoutWorkflowRegistration() {
  const registration = {
    description: 'Start checkout from registration metadata',
    tags: ['Registration', 'Checkout'],
    inputSchema: checkoutInputSchema,
    handler: async function* (_context: WorkflowContext) {
      return { completed: true };
    },
  } satisfies WorkflowRegistration<CheckoutInput, { completed: true }>;
  return registration;
}

function makeDefinitionSchema<TOutput>(): DefinitionSchema<unknown, TOutput> {
  return {
    '~standard': {
      version: 1,
      vendor: 'weft-test',
      validate: (value) => ({ value: value as TOutput }),
    },
  };
}

function catalogCheckoutWorkflow() {
  return catalogWorkflow<CheckoutInput>({
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

describe('catalogWorkflow', () => {
  it('marks cataloged workflows non-destructive (start operations are additive)', () => {
    // catalogWorkflow-built operations are created per deployment and never
    // appear in the live registry, so the registry exhaustiveness test cannot
    // cover them. Pin the factory's hardcoded value directly.
    expect(catalogCheckoutWorkflow().destructive).toBe(false);
  });

  it('starts the workflow and returns only the start handle', async () => {
    const engine = createEngine();
    registerCheckoutWorkflow(engine);
    const registry = createOperationRegistry([catalogCheckoutWorkflow()]);

    const result = await executeOperation<StartHandle>(
      'weft.workflows.checkout.start',
      { orderId: 'ord_1', amount: 42 },
      {
        principal: anonymousPrincipal(),
        engine,
        transport: 'http-rest',
        registry,
      },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    expect(result.value.status).toBe('started');
    expect(typeof result.value.workflowId).toBe('string');
    expect(result.value).not.toHaveProperty('completed');

    const workflowResult = await engine.getHandle(result.value.workflowId).result();
    expect(workflowResult).toEqual({
      completed: true,
      input: { orderId: 'ord_1', amount: 42 },
    });
  });

  it('dispatches over JSON-RPC HTTP and passes the entire validated input to engine.start', async () => {
    const engine = createEngine();
    registerCheckoutWorkflow(engine);
    const registry = createOperationRegistry([catalogCheckoutWorkflow()]);

    const result = await executeOperation<StartHandle>(
      'weft.workflows.checkout.start',
      { orderId: 'ord_2', amount: 19 },
      {
        principal: anonymousPrincipal(),
        engine,
        transport: 'jsonRpcHttp',
        registry,
      },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');

    const workflowResult = await engine.getHandle(result.value.workflowId).result();
    expect(workflowResult).toEqual({
      completed: true,
      input: { orderId: 'ord_2', amount: 19 },
    });
  });

  it('rejects invalid input before starting the workflow', async () => {
    const engine = createEngine();
    registerCheckoutWorkflow(engine);
    const registry = createOperationRegistry([catalogCheckoutWorkflow()]);

    const result = await executeOperation(
      'weft.workflows.checkout.start',
      { orderId: 'ord_3' },
      {
        principal: anonymousPrincipal(),
        engine,
        transport: 'jsonRpcHttp',
        registry,
      },
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected fault');
    expect(result.fault.code).toBe('InvalidParams');
  });

  it('invokes the authorize hook with parsed input', async () => {
    const engine = createEngine();
    registerCheckoutWorkflow(engine);
    const seenAmounts: number[] = [];
    const registry = createOperationRegistry([
      catalogWorkflow<CheckoutInput>({
        name: 'weft.workflows.checkout.start',
        mcpExposable: false,
        workflowType: 'checkout',
        summary: 'Start a checkout workflow',
        inputSchema: checkoutInputSchema,
        access: { kind: 'authenticated' },
        transports: catalogTransports,
        unknownKeyPolicy: catalogUnknownKeyPolicy,
        authorize: async ({ input }) => {
          seenAmounts.push(input.amount);
          return { allowed: true };
        },
      }),
    ]);

    const result = await executeOperation(
      'weft.workflows.checkout.start',
      { orderId: 'ord_4', amount: 25 },
      {
        principal: principalFromApiKey({ subject: 'test-key', scopes: [] }),
        engine,
        transport: 'jsonRpcHttp',
        registry,
      },
    );

    expect(result.ok).toBe(true);
    expect(seenAmounts).toEqual([25]);
  });

  it('defaults to a passthrough empty input schema when omitted', async () => {
    const engine = createEngine();
    engine.register(looseWorkflowWorkflow);
    const registry = createOperationRegistry([
      catalogWorkflow<Record<string, unknown>>({
        name: 'weft.workflows.loose.start',
        mcpExposable: false,
        workflowType: 'loose-workflow',
        summary: 'Start a loose workflow',
        access: { kind: 'public' },
        transports: catalogTransports,
        unknownKeyPolicy: { http: 'passthrough', jsonRpc: 'passthrough' },
      }),
    ]);

    const result = await executeOperation<StartHandle>(
      'weft.workflows.loose.start',
      { arbitrary: true, count: 2 },
      {
        principal: anonymousPrincipal(),
        engine,
        transport: 'jsonRpcHttp',
        registry,
      },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    const workflowResult = await engine.getHandle(result.value.workflowId).result();
    expect(Object.fromEntries(Object.entries(workflowResult as Record<string, unknown>))).toEqual({
      arbitrary: true,
      count: 2,
    });
  });

  it('uses workflow registration metadata as adapter defaults', async () => {
    const registration: WorkflowRegistration<CheckoutInput, { completed: true }> =
      checkoutWorkflowRegistration();
    const engine = createEngine();
    engine.register(
      workflow({
        name: 'checkout',
        ...(registration.description === undefined
          ? {}
          : { description: registration.description }),
        ...(registration.tags === undefined ? {} : { tags: registration.tags }),
        ...(registration.inputSchema === undefined
          ? {}
          : { inputSchema: registration.inputSchema }),
      }).execute(registration.handler),
    );
    const registry = createOperationRegistry([
      catalogWorkflow<CheckoutInput>({
        name: 'weft.workflows.checkout.start',
        mcpExposable: false,
        workflowType: 'checkout',
        registration,
        access: { kind: 'public' },
        transports: catalogTransports,
        unknownKeyPolicy: catalogUnknownKeyPolicy,
      }),
    ]);

    const operation = registry.get('weft.workflows.checkout.start');
    expect(operation?.summary).toBe('Start checkout from registration metadata');
    expect(operation?.tags).toEqual(['Registration', 'Checkout']);
    expect(operation?.inputSchema).toBe(checkoutInputSchema);

    const result = await executeOperation<StartHandle>(
      'weft.workflows.checkout.start',
      { orderId: 'ord_registration', amount: 99 },
      {
        principal: anonymousPrincipal(),
        engine,
        transport: 'jsonRpcHttp',
        registry,
      },
    );

    expect(result.ok).toBe(true);
  });

  it('lets adapter options override workflow registration presentation metadata', () => {
    const registration = checkoutWorkflowRegistration();
    const registry = createOperationRegistry([
      catalogWorkflow<CheckoutInput>({
        name: 'weft.workflows.checkout.start',
        mcpExposable: false,
        workflowType: 'checkout',
        registration,
        summary: 'Adapter-specific checkout start',
        tags: ['Adapter'],
        inputSchema: z.object({ orderId: z.string(), amount: z.number().min(1) }),
        access: { kind: 'public' },
        transports: catalogTransports,
        unknownKeyPolicy: catalogUnknownKeyPolicy,
      }),
    ]);

    const operation = registry.get('weft.workflows.checkout.start');
    expect(operation?.summary).toBe('Adapter-specific checkout start');
    expect(operation?.tags).toEqual(['Adapter']);
    expect(operation?.inputSchema).not.toBe(checkoutInputSchema);
  });

  it('fails closed when registration schema metadata cannot become a catalog input schema', () => {
    const registration = {
      ...checkoutWorkflowRegistration(),
      inputSchema: makeDefinitionSchema<CheckoutInput>(),
    };

    expect(() =>
      catalogWorkflow<CheckoutInput>({
        name: 'weft.workflows.checkout.start',
        mcpExposable: false,
        workflowType: 'checkout',
        registration,
        access: { kind: 'public' },
        transports: catalogTransports,
        unknownKeyPolicy: catalogUnknownKeyPolicy,
      }),
    ).toThrow('Pass inputSchema explicitly for other DefinitionSchema implementations');

    expect(() =>
      catalogWorkflow<CheckoutInput>({
        name: 'weft.workflows.checkout.start',
        mcpExposable: false,
        workflowType: 'checkout',
        registration,
        inputSchema: checkoutInputSchema,
        access: { kind: 'public' },
        transports: catalogTransports,
        unknownKeyPolicy: catalogUnknownKeyPolicy,
      }),
    ).not.toThrow();
  });

  it('maps engine start failures to operation faults', async () => {
    const cases = [
      {
        error: new StartWorkflowValidationError('Field "id" must be a string'),
        expectedCode: 'InvalidParams',
      },
      {
        error: new WorkflowNotRegisteredError('missing'),
        expectedCode: 'InvalidParams',
      },
      {
        error: new WorkflowAlreadyExistsError('checkout'),
        expectedCode: 'Conflict',
      },
      {
        error: new Error('database unavailable'),
        expectedCode: 'EngineFailure',
      },
    ] as const;

    for (const testCase of cases) {
      const engine = createEngine();
      engine.start = async () => {
        throw testCase.error;
      };
      const registry = createOperationRegistry([catalogCheckoutWorkflow()]);

      const result = await executeOperation(
        'weft.workflows.checkout.start',
        { orderId: 'ord_5', amount: 12 },
        {
          principal: anonymousPrincipal(),
          engine,
          transport: 'jsonRpcHttp',
          registry,
        },
      );

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('expected fault');
      expect(result.fault.code).toBe(testCase.expectedCode);
    }
  });

  it('appears in generated OpenRPC documents with the hard-coded start handle result schema', () => {
    const registry = createOperationRegistry([catalogCheckoutWorkflow()]);

    const document = generateOpenRpcDocument({ registry, transports: ['http'] });
    const methods = document['methods'] as Array<Record<string, unknown>>;
    const method = methods.find(
      (candidate) => candidate['name'] === 'weft.workflows.checkout.start',
    );
    expect(method).toBeDefined();
    if (method === undefined) throw new Error('expected method');
    expect(method['summary']).toBe('Start a checkout workflow');
    expect(method['tags']).toEqual([{ name: 'Checkout' }, { name: 'Workflows' }]);
    expect(method['result']).toMatchObject({
      name: 'result',
      required: true,
      schema: {
        type: 'object',
        properties: {
          workflowId: { type: 'string' },
          status: { type: 'string' },
        },
        required: ['workflowId', 'status'],
      },
    });
  });
});
