import { describe, expect, expectTypeOf, it } from 'bun:test';
import { z } from 'zod';

import { anonymousPrincipal, principalFromApiKey } from '../principal.ts';
import { createOperationRegistry, executeOperation } from './index.ts';
import {
  catalogCheckoutWorkflow,
  catalogTransports,
  catalogUnknownKeyPolicy,
  checkoutInputSchema,
  createEngine,
  looseWorkflowWorkflow,
  parsedStartHandle,
  registerCheckoutWorkflow,
} from './workflow-adapter.test-support.ts';
import { catalogWorkflow } from './workflow-adapter.ts';

describe('catalogWorkflow — execution', () => {
  it('derives authorization input from the explicit Zod schema', () => {
    const inputSchema = z.object({ count: z.number().default(0) });
    const operation = catalogWorkflow({
      name: 'weft.workflows.schemaderived',
      mcpExposable: false,
      workflowType: 'checkout',
      inputSchema,
      access: { kind: 'public' },
      transports: catalogTransports,
      unknownKeyPolicy: catalogUnknownKeyPolicy,
      authorize: async ({ input }) => {
        expectTypeOf(input).toEqualTypeOf<{ count: number }>();
        return input.count >= 0
          ? { allowed: true }
          : { allowed: false, reason: 'count must be nonnegative' };
      },
    });

    expectTypeOf(operation.inputSchema).toEqualTypeOf(inputSchema);
  });

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

    const result = await executeOperation(
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
    const handle = parsedStartHandle(result.value);
    expect(handle.status).toBe('started');
    expect(typeof handle.workflowId).toBe('string');
    expect(handle).not.toHaveProperty('completed');

    const workflowResult = await engine.getHandle(handle.workflowId).result();
    expect(workflowResult).toEqual({
      completed: true,
      input: { orderId: 'ord_1', amount: 42 },
    });
  });

  it('dispatches over JSON-RPC HTTP and passes the entire validated input to engine.start', async () => {
    const engine = createEngine();
    registerCheckoutWorkflow(engine);
    const registry = createOperationRegistry([catalogCheckoutWorkflow()]);

    const result = await executeOperation(
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

    const workflowResult = await engine
      .getHandle(parsedStartHandle(result.value).workflowId)
      .result();
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
      catalogWorkflow({
        name: 'weft.workflows.checkout.start',
        mcpExposable: false,
        workflowType: 'checkout',
        summary: 'Start a checkout workflow',
        inputSchema: checkoutInputSchema,
        access: { kind: 'authenticated' },
        transports: catalogTransports,
        unknownKeyPolicy: catalogUnknownKeyPolicy,
        authorize: async ({ input }) => {
          seenAmounts.push(checkoutInputSchema.parse(input).amount);
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
      catalogWorkflow({
        name: 'weft.workflows.loose.start',
        mcpExposable: false,
        workflowType: 'loose-workflow',
        summary: 'Start a loose workflow',
        access: { kind: 'public' },
        transports: catalogTransports,
        unknownKeyPolicy: { http: 'passthrough', jsonRpc: 'passthrough' },
      }),
    ]);

    const result = await executeOperation(
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
    const workflowResult = await engine
      .getHandle(parsedStartHandle(result.value).workflowId)
      .result();
    expect(workflowResult).toEqual({
      arbitrary: true,
      count: 2,
    });
  });
});
