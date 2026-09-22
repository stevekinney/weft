import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import {
  WorkflowAlreadyExistsError,
  WorkflowNotRegisteredError,
} from '../../core/engine/errors.ts';
import { StartWorkflowValidationError } from '../../core/start-workflow-validation.ts';
import { workflow } from '../../core/types.ts';
import { generateOpenRpcDocument } from '../openrpc.ts';
import { anonymousPrincipal } from '../principal.ts';
import { createOperationRegistry, executeOperation } from './index.ts';
import {
  catalogCheckoutWorkflow,
  catalogTransports,
  catalogUnknownKeyPolicy,
  checkoutInputSchema,
  checkoutWorkflowRegistration,
  createEngine,
  makeDefinitionSchema,
  type CheckoutInput,
  type WorkflowRegistrationFixture,
} from './workflow-adapter.test-support.ts';
import { catalogWorkflow } from './workflow-adapter.ts';

describe('catalogWorkflow — registration and metadata', () => {
  it('uses workflow registration metadata as adapter defaults', async () => {
    const registration: WorkflowRegistrationFixture<CheckoutInput, { completed: true }> =
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
      catalogWorkflow({
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

    const result = await executeOperation(
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

  it("checkoutWorkflowRegistration()'s handler runs to completion and returns { completed: true }", async () => {
    // `executeOperation('weft.workflows.checkout.start', ...)` above starts
    // the workflow without awaiting its result, so the fixture's own
    // generator body is not provably driven to completion by that test.
    // Drive it directly here instead.
    const registration = checkoutWorkflowRegistration();
    // The fixture's handler takes only the context; its input is fixed by the registration.
    const iterator = registration.handler({} as never);
    let step = await iterator.next();
    while (!step.done) {
      step = await iterator.next();
    }
    expect(step.value).toEqual({ completed: true });
  });

  it('lets adapter options override workflow registration presentation metadata', () => {
    const registration = checkoutWorkflowRegistration();
    const registry = createOperationRegistry([
      catalogWorkflow({
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
      catalogWorkflow({
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
      catalogWorkflow({
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
    const methodsValue = document['methods'];
    if (!Array.isArray(methodsValue)) throw new Error('expected methods array');
    const method = methodsValue
      .filter(isRecord)
      .find((candidate) => candidate['name'] === 'weft.workflows.checkout.start');
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
