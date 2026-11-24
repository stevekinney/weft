import { afterEach, describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { principalFromApiKey } from "../../embedded/backchannel/src/index.ts";
import {
  createOperationRegistry,
  executeOperation,
  generateOpenApiDocument,
  generateOpenRpcDocument,
} from "../../embedded/backchannel/src/internals.ts";
import { removeWorkflowRevision } from '../../core/engine/catalog-removal.ts';
import { deriveWorkflowDefinitionRevision } from '../../core/engine/definition-revision.ts';
import { workflowSource } from '../../core/source/index.ts';
import { workflow, type WorkflowDefinition } from '../../core/types.ts';
import { registerWorkflowDocuments } from '../../document-workflow/register.ts';
import { handleRequest } from '../handler.ts';
import { createLiveOperationRegistry, createLiveRestBindings } from '../rest-bindings.ts';
import {
  getWorkflowDefinitionOperation,
  getWorkflowDefinitionRestBinding,
} from './get-workflow-definition.ts';
import {
  createOperationTestEngine,
  systemReadAuthContext,
} from './operation-registry-test-helpers.test-support.ts';

const registry = createOperationRegistry([getWorkflowDefinitionOperation]);
const requestOptions = {
  operationRegistry: registry,
  restBindings: [getWorkflowDefinitionRestBinding],
};

function typed(name: string): WorkflowDefinition {
  return workflow({
    name,
    version: '3.0.0',
    description: 'Typed',
    inputSchema: z.object({ orderId: z.string() }),
    outputSchema: z.object({ shipped: z.boolean() }),
  }).execute(async function* () {
    return { shipped: true };
  });
}

async function sourceFor(definition: WorkflowDefinition, load = async () => ({ w: definition })) {
  return workflowSource(
    {
      name: definition.name,
      location: `./${definition.name}.ts`,
      exportName: 'w',
      revision: await deriveWorkflowDefinitionRevision(definition),
    },
    load,
  );
}

async function getDefinition(engine: unknown, name: string): Promise<Response> {
  return handleRequest(
    new Request(`http://localhost/v1/registry/definitions/${name}`),
    engine as never,
    { ...requestOptions, ...systemReadAuthContext() },
  );
}

describe('weft.workflows.definitions.get: GET /v1/registry/definitions/:name', () => {
  let engine: ReturnType<typeof createOperationTestEngine> | undefined;

  afterEach(() => {
    engine?.[Symbol.dispose]();
    engine = undefined;
  });

  it("returns a code type's full contract, input and output schemas included", async () => {
    engine = createOperationTestEngine();
    engine.register(typed('orders'));

    const response = await getDefinition(engine, 'orders');
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      name: 'orders',
      origin: 'code',
      state: 'ready',
      workflowVersion: '3.0.0',
      contractHash: expect.stringMatching(/^sha256:/),
      contract: {
        name: 'orders',
        workflowVersion: '3.0.0',
        inputSchema: { type: 'object', properties: { orderId: { type: 'string' } } },
        outputSchema: { type: 'object', properties: { shipped: { type: 'boolean' } } },
      },
    });
  });

  it('returns the contract of a source only once it is loaded, and never loads it itself', async () => {
    engine = createOperationTestEngine();
    const definition = typed('lazy');
    let loads = 0;
    const lazy = await sourceFor(definition, async () => {
      loads += 1;
      return { w: definition };
    });
    engine.registerSource(lazy);

    const idleResponse = await getDefinition(engine, 'lazy');
    const idle = (await idleResponse.json()) as Record<string, unknown>;
    expect(idle).toMatchObject({
      state: 'idle',
      revision: lazy.descriptor.revision,
      contract: null,
    });
    expect(loads).toBe(0);

    await engine.workflows.preload('lazy', lazy.descriptor.revision);
    const readyResponse = await getDefinition(engine, 'lazy');
    const ready = (await readyResponse.json()) as Record<string, unknown>;
    expect(ready).toMatchObject({
      state: 'ready',
      origin: 'source',
      contract: { name: 'lazy', workflowVersion: '3.0.0' },
    });
  });

  it('never returns ready with a null contract: a preloaded source whose revision was removed is idle', async () => {
    engine = createOperationTestEngine();
    const lazy = await sourceFor(typed('removed-lazy'));
    engine.registerSource(lazy);
    await engine.workflows.preload('removed-lazy', lazy.descriptor.revision);
    await removeWorkflowRevision(engine, 'removed-lazy', lazy.descriptor.revision);

    const response = await getDefinition(engine, 'removed-lazy');
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ state: 'idle', contract: null, contractHash: null });
  });

  it('lists the signals a document awaits in the contract it returns', async () => {
    engine = createOperationTestEngine();
    await registerWorkflowDocuments(
      engine,
      { activities: {}, triggerKinds: { manual: () => undefined } },
      {
        active: [
          {
            name: 'approval-flow',
            trigger: { kind: 'manual' },
            steps: [
              { kind: 'await-signal', signal: 'approve' },
              { kind: 'await-signal', signal: 'cancel' },
            ],
          },
        ],
      },
    );

    const response = await getDefinition(engine, 'approval-flow');
    const body = (await response.json()) as {
      signals: string[];
      contract: { signals: Record<string, unknown> };
    };

    expect(body.signals).toEqual(['approve', 'cancel']);
    expect(Object.keys(body.contract.signals)).toEqual(['approve', 'cancel']);
  });

  it('returns not-found for a name that is not a workflow type', async () => {
    engine = createOperationTestEngine();

    const response = await getDefinition(engine, 'nonexistent');

    expect(response.status).toBe(404);
  });

  it('rejects a name outside the wire-safe grammar', async () => {
    engine = createOperationTestEngine();

    const response = await getDefinition(engine, 'not.valid');

    expect(response.status).toBe(400);
  });

  it('has no owner or author field in its output', () => {
    const keys = Object.keys(getWorkflowDefinitionOperation.outputSchema.shape);

    expect(keys.filter((key) => /owner|author/i.test(key))).toEqual([]);
  });

  it('is readable with system:read or workflows:read and refuses other scopes', async () => {
    engine = createOperationTestEngine();
    engine.register(typed('orders'));
    const outcomes: boolean[] = [];
    for (const scope of ['system:read', 'workflows:read', 'workflows:write'] as const) {
      const result = await executeOperation(
        'weft.workflows.definitions.get',
        { name: 'orders' },
        {
          principal: principalFromApiKey({ subject: 'reader', scopes: [scope] }),
          host: engine,
          transport: 'jsonRpcStdio',
          registry,
        },
      );
      outcomes.push(result.ok);
    }

    expect(outcomes).toEqual([true, true, false]);
  });

  it('appears in the OpenRPC document and the REST surface', () => {
    const live = createLiveOperationRegistry();
    const rpc = generateOpenRpcDocument({ registry: live, transports: ['http'] }) as {
      methods: { name: string }[];
    };
    const openApi = generateOpenApiDocument({
      registry: live,
      restBindings: createLiveRestBindings(),
    }) as { paths: Record<string, unknown> };

    expect(rpc.methods.map((method) => method.name)).toContain('weft.workflows.definitions.get');
    expect(Object.keys(openApi.paths)).toContain('/api/v1/registry/definitions/{name}');
    expect(live.get('weft.workflows.definitions.get')?.mcpExposable).toBe(false);
  });
});
