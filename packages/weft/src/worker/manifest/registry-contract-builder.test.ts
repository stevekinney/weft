import { afterEach, describe, expect, it } from 'bun:test';
import { z } from 'zod';

import {
  activityContractHash,
  contractHash,
  deriveWorkflowRevision,
} from '../../core/contract/index.ts';
import { Engine } from '../../core/engine.ts';
import { activity, query, signal, update, workflow } from '../../core/types.ts';
import { definitionSchemaToJsonSchema } from '../../core/types/definition-schema-to-json.ts';
import { REMOTE_WORKER_PROTOCOL_VERSION } from '../protocol.ts';
import {
  buildWorkerManifestFromRegistry,
  WorkerManifestBuildError,
} from './registry-contract-builder.ts';

const DEPLOYMENT = { name: 'billing', buildId: 'build-42', artifactDigest: 'sha256:aaaa' };
const RUNTIME = { name: 'bun', version: '1.3.14' };

function createEngine(): Engine {
  return new Engine();
}

describe('buildWorkerManifestFromRegistry', () => {
  let engine: Engine | undefined;

  afterEach(() => {
    engine?.[Symbol.dispose]();
    engine = undefined;
  });

  it('builds a manifest carrying the requested deployment, runtime, and protocol identity', async () => {
    engine = createEngine();
    engine.register(workflow({ name: 'checkout' }).execute(async function* () {}));

    const manifest = await buildWorkerManifestFromRegistry(engine, {
      workflows: { checkout: [] },
      deployment: DEPLOYMENT,
      runtime: RUNTIME,
    });

    expect(manifest.deployment).toEqual(DEPLOYMENT);
    expect(manifest.runtime).toEqual(RUNTIME);
    expect(manifest.protocolVersion).toBe(REMOTE_WORKER_PROTOCOL_VERSION);
    expect(manifest.capabilities).toEqual({});
  });

  it('reports the real workflowVersion from the registered definition', async () => {
    engine = createEngine();
    engine.register(
      workflow({ name: 'checkout', version: '2.1.0' }).execute(async function* () {}),
    );

    const manifest = await buildWorkerManifestFromRegistry(engine, {
      workflows: { checkout: [] },
      deployment: DEPLOYMENT,
      runtime: RUNTIME,
    });

    expect(manifest.workflows['checkout']?.workflowVersion).toBe('2.1.0');
  });

  it('produces a real sha256 contractHash derived from the schema content, not a declared-shape placeholder', async () => {
    engine = createEngine();
    engine.register(
      workflow({
        name: 'checkout',
        inputSchema: z.object({ cartId: z.string() }),
        outputSchema: z.object({ orderId: z.string() }),
      }).execute(async function* () {}),
    );

    const manifest = await buildWorkerManifestFromRegistry(engine, {
      workflows: { checkout: [] },
      deployment: DEPLOYMENT,
      runtime: RUNTIME,
    });

    const contract = manifest.workflows['checkout'];
    expect(contract?.contractHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(contract?.contractHash).not.toMatch(/^declared-shape:/);
  });

  it('changes contractHash when the schema content changes but not when only description changes', async () => {
    async function manifestFor(input: {
      inputSchema: z.ZodTypeAny;
      description?: string;
    }): Promise<string> {
      const localEngine = createEngine();
      try {
        localEngine.register(
          workflow({
            name: 'checkout',
            inputSchema: input.inputSchema,
            ...(input.description !== undefined ? { description: input.description } : {}),
          }).execute(async function* () {}),
        );
        const manifest = await buildWorkerManifestFromRegistry(localEngine, {
          workflows: { checkout: [] },
          deployment: DEPLOYMENT,
          runtime: RUNTIME,
        });
        return manifest.workflows['checkout']?.contractHash ?? '';
      } finally {
        localEngine[Symbol.dispose]();
      }
    }

    const schema = z.object({ cartId: z.string() });
    const differentSchema = z.object({ cartId: z.number() });

    const base = await manifestFor({ inputSchema: schema });
    const withDescription = await manifestFor({ inputSchema: schema, description: 'Checks out.' });
    const withDifferentSchema = await manifestFor({ inputSchema: differentSchema });

    expect(withDescription).toBe(base);
    expect(withDifferentSchema).not.toBe(base);
  });

  it('changes workflowRevision when the workflowVersion changes even if the schema does not', async () => {
    async function revisionFor(version: string): Promise<string> {
      const localEngine = createEngine();
      try {
        localEngine.register(
          workflow({ name: 'checkout', version }).execute(async function* () {}),
        );
        const manifest = await buildWorkerManifestFromRegistry(localEngine, {
          workflows: { checkout: [] },
          deployment: DEPLOYMENT,
          runtime: RUNTIME,
        });
        return manifest.workflows['checkout']?.workflowRevision ?? '';
      } finally {
        localEngine[Symbol.dispose]();
      }
    }

    expect(await revisionFor('1.0.0')).not.toBe(await revisionFor('2.0.0'));
  });

  it('derives per-activity contractHash from the activity schema and sets implementationRevision from buildId', async () => {
    engine = createEngine();
    engine.register(workflow({ name: 'checkout' }).execute(async function* () {}));
    engine.register(
      activity({
        name: 'charge',
        execute: async () => ({ charged: true }),
        inputSchema: z.object({ amount: z.number() }),
        outputSchema: z.object({ charged: z.boolean() }),
      }),
    );

    const manifest = await buildWorkerManifestFromRegistry(engine, {
      workflows: { checkout: ['charge'] },
      deployment: DEPLOYMENT,
      runtime: RUNTIME,
    });

    const chargeContract = manifest.workflows['checkout']?.activities['charge'];
    expect(chargeContract?.contractHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(chargeContract?.implementationRevision).toBe(DEPLOYMENT.buildId);
  });

  it('throws WorkerManifestBuildError when a declared workflow type is not registered', async () => {
    engine = createEngine();

    await expect(
      buildWorkerManifestFromRegistry(engine, {
        workflows: { 'not-registered': [] },
        deployment: DEPLOYMENT,
        runtime: RUNTIME,
      }),
    ).rejects.toThrow(WorkerManifestBuildError);
  });

  it('throws WorkerManifestBuildError when a declared activity is not registered', async () => {
    engine = createEngine();
    engine.register(workflow({ name: 'checkout' }).execute(async function* () {}));

    await expect(
      buildWorkerManifestFromRegistry(engine, {
        workflows: { checkout: ['not-registered'] },
        deployment: DEPLOYMENT,
        runtime: RUNTIME,
      }),
    ).rejects.toThrow(WorkerManifestBuildError);
  });

  it('produces identical manifests across two builds of the same registry (deterministic)', async () => {
    async function build(): Promise<unknown> {
      const localEngine = createEngine();
      try {
        localEngine.register(
          workflow({
            name: 'checkout',
            inputSchema: z.object({ cartId: z.string() }),
          }).execute(async function* () {}),
        );
        localEngine.register(
          activity({
            name: 'charge',
            execute: async () => true,
            inputSchema: z.object({ amount: z.number() }),
          }),
        );
        return await buildWorkerManifestFromRegistry(localEngine, {
          workflows: { checkout: ['charge'] },
          deployment: DEPLOYMENT,
          runtime: RUNTIME,
        });
      } finally {
        localEngine[Symbol.dispose]();
      }
    }

    expect(await build()).toEqual(await build());
  });

  it('omits activities the caller did not declare for a workflow, even if the engine has more registered', async () => {
    engine = createEngine();
    engine.register(workflow({ name: 'checkout' }).execute(async function* () {}));
    engine.register(activity({ name: 'charge', execute: async () => true }));
    engine.register(activity({ name: 'refund', execute: async () => true }));

    const manifest = await buildWorkerManifestFromRegistry(engine, {
      workflows: { checkout: ['charge'] },
      deployment: DEPLOYMENT,
      runtime: RUNTIME,
    });

    expect(Object.keys(manifest.workflows['checkout']?.activities ?? {})).toEqual(['charge']);
  });

  it('folds registered signals, updates, and queries into contractHash (WFT-5)', async () => {
    async function contractHashFor(withMessages: boolean): Promise<string> {
      const localEngine = createEngine();
      try {
        const definition = withMessages
          ? workflow({ name: 'checkout' })
              .signals({ cancel: signal('cancel') })
              .updates({
                rename: update('rename', { inputSchema: z.object({ name: z.string() }) }),
              })
              .queries({
                status: query('status', { outputSchema: z.object({ state: z.string() }) }),
              })
              .execute(async function* () {})
          : workflow({ name: 'checkout' }).execute(async function* () {});
        localEngine.register(definition);
        const manifest = await buildWorkerManifestFromRegistry(localEngine, {
          workflows: { checkout: [] },
          deployment: DEPLOYMENT,
          runtime: RUNTIME,
        });
        return manifest.workflows['checkout']?.contractHash ?? '';
      } finally {
        localEngine[Symbol.dispose]();
      }
    }

    expect(await contractHashFor(true)).not.toBe(await contractHashFor(false));
  });

  it('routes contractHash/workflowRevision/activity contractHash through the core/contract functions directly (unification)', async () => {
    const chargeInputSchema = z.object({ amount: z.number() });
    const chargeOutputSchema = z.object({ charged: z.boolean() });

    engine = createEngine();
    engine.register(
      workflow({ name: 'checkout', version: '2.1.0' })
        .signals({ cancel: signal('cancel') })
        .execute(async function* () {}),
    );
    engine.register(
      activity({
        name: 'charge',
        execute: async () => ({ charged: true }),
        inputSchema: chargeInputSchema,
        outputSchema: chargeOutputSchema,
      }),
    );

    const manifest = await buildWorkerManifestFromRegistry(engine, {
      workflows: { checkout: ['charge'] },
      deployment: DEPLOYMENT,
      runtime: RUNTIME,
    });

    const workflowContract = manifest.workflows['checkout'];
    const activityContract = workflowContract?.activities['charge'];

    // Built independently from the same schemas, via the same JSON Schema
    // converter the registry uses — not by reading back the manifest's own
    // output — so this proves the manifest's digests equal an equivalent
    // hand-built WorkflowContract's, not merely that some hash came out.
    const equivalentContract = {
      name: 'checkout',
      workflowVersion: '2.1.0',
      signals: { cancel: {} },
      activities: {
        charge: {
          inputSchema: definitionSchemaToJsonSchema(chargeInputSchema, 'input'),
          outputSchema: definitionSchemaToJsonSchema(chargeOutputSchema, 'output'),
        },
      },
    };

    expect(workflowContract?.contractHash).toBe(await contractHash(equivalentContract));
    expect(workflowContract?.workflowRevision).toBe(
      await deriveWorkflowRevision(equivalentContract),
    );
    expect(activityContract?.contractHash).toBe(
      await activityContractHash(equivalentContract.activities.charge),
    );
  });

  it('defaults sdkVersion and protocolVersion, and accepts explicit overrides', async () => {
    engine = createEngine();
    engine.register(workflow({ name: 'checkout' }).execute(async function* () {}));

    const manifest = await buildWorkerManifestFromRegistry(engine, {
      workflows: { checkout: [] },
      deployment: DEPLOYMENT,
      runtime: RUNTIME,
      protocolVersion: 999,
      sdkVersion: '9.9.9',
    });

    expect(manifest.protocolVersion).toBe(999);
    expect(manifest.sdkVersion).toBe('9.9.9');
  });
});
