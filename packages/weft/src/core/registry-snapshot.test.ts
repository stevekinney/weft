/**
 * Tests for the registry snapshot builder.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { MemoryStorage } from '../storage/memory.ts';
import { ActivityRegistry } from './activity-registry.ts';
import { buildWorkflowContract } from './contract/build.ts';
import { buildWorkflowRevisionManifest } from './contract/manifest.ts';
import { Engine } from './engine.ts';
import { getWorkflowCatalog } from './engine/index.ts';
import { MAX_REGISTRY_WORKFLOW_COUNT, RegistryWorkflowCountLimitError } from './registry-limits.ts';
import {
  buildRegistrySnapshot,
  buildWorkflowManifestForType,
  compareWorkflowManifests,
  REGISTRY_VERSION,
  RegistryManifestLimitError,
  RegistrySchemaConversionError,
} from './registry-snapshot.ts';
import type { WorkflowDefinition } from './types.ts';
import { activity, query, signal, update, workflow } from './types.ts';

function createEngine(): Engine {
  return new Engine({ storage: new MemoryStorage() });
}

/** Find the active manifest for `name` — every workflow entry in these tests has exactly one registered revision. */
function findManifest(snapshot: Awaited<ReturnType<typeof buildRegistrySnapshot>>, name: string) {
  const revision = snapshot.activeRevisions[name];
  return snapshot.workflows.find((m) => m.name === name && m.revision === revision);
}

describe('buildRegistrySnapshot', () => {
  let engine: Engine | undefined;

  afterEach(() => {
    engine?.[Symbol.dispose]();
    engine = undefined;
  });

  it('returns registryVersion 2', async () => {
    engine = createEngine();
    const snapshot = await buildRegistrySnapshot(engine);
    expect(snapshot.registryVersion).toBe(REGISTRY_VERSION);
    expect(snapshot.registryVersion).toBe(2);
  });

  it('generatedAt reflects the injected clock', async () => {
    engine = createEngine();
    const snapshot = await buildRegistrySnapshot(engine, { now: () => 0 });
    expect(snapshot.generatedAt).toBe('1970-01-01T00:00:00.000Z');
  });

  it('two consecutive buildRegistrySnapshot calls produce identical output apart from generatedAt', async () => {
    engine = createEngine();
    engine.register(
      workflow({
        name: 'welcome',
        inputSchema: z.object({ name: z.string() }),
        description: 'Greets a person.',
        tags: ['demo'],
      }).execute(async function* () {}),
    );
    engine.register(activity({ name: 'ping', execute: async () => undefined }));

    // Pin the same clock value on both calls so the only thing that could
    // differ is non-determinism in the builder itself — `generatedAt`
    // equality is asserted directly rather than excluded, since both calls
    // share one fixed `now`.
    const first = await buildRegistrySnapshot(engine, { now: () => 1_000 });
    const second = await buildRegistrySnapshot(engine, { now: () => 1_000 });
    expect(second).toEqual(first);
  });

  it('includes workflows with their schema, description, and tags', async () => {
    engine = createEngine();
    const welcomeWorkflow = workflow({
      name: 'welcome',
      inputSchema: z.object({ name: z.string() }),
      outputSchema: z.object({ greeting: z.string() }),
      description: 'Greets a person.',
      tags: ['greeting', 'demo'],
    }).execute(async function* () {
      return { greeting: 'hi' };
    });
    engine.register(welcomeWorkflow);

    const snapshot = await buildRegistrySnapshot(engine);
    const manifest = findManifest(snapshot, 'welcome');

    expect(manifest?.contract).toEqual({
      name: 'welcome',
      workflowVersion: '0.0.0',
      description: 'Greets a person.',
      // Tags come back alphabetically sorted on the wire (normalizeWorkflowContract),
      // not in registration order — a deliberate v2 behavior change (CHANGELOG.md).
      tags: ['demo', 'greeting'],
      inputSchema: {
        type: 'object',
        properties: { name: { type: 'string' } },
        required: ['name'],
        additionalProperties: false,
      },
      outputSchema: {
        type: 'object',
        properties: { greeting: { type: 'string' } },
        required: ['greeting'],
        additionalProperties: false,
      },
    });
  });

  it('includes registered signal, update, and query schemas', async () => {
    engine = createEngine();
    const interactiveWorkflow = workflow({ name: 'interactive' })
      .signals({
        ping: signal('ping'),
        approve: signal('approve', {
          inputSchema: z.object({ approvedBy: z.string() }),
        }),
      })
      .updates({
        rename: update('rename', {
          inputSchema: z.object({ name: z.string() }),
          outputSchema: z.object({ accepted: z.boolean() }),
        }),
      })
      .queries({
        status: query('status', {
          outputSchema: z.object({ state: z.string() }),
        }),
      })
      .execute(async function* () {});
    engine.register(interactiveWorkflow);

    const snapshot = await buildRegistrySnapshot(engine);
    const manifest = findManifest(snapshot, 'interactive');

    expect(manifest?.contract).toMatchObject({
      signals: {
        approve: {
          inputSchema: {
            type: 'object',
            properties: { approvedBy: { type: 'string' } },
            required: ['approvedBy'],
            additionalProperties: false,
          },
        },
        ping: {},
      },
      updates: {
        rename: {
          inputSchema: {
            type: 'object',
            properties: { name: { type: 'string' } },
            required: ['name'],
            additionalProperties: false,
          },
          outputSchema: {
            type: 'object',
            properties: { accepted: { type: 'boolean' } },
            required: ['accepted'],
            additionalProperties: false,
          },
        },
      },
      queries: {
        status: {
          outputSchema: {
            type: 'object',
            properties: { state: { type: 'string' } },
            required: ['state'],
            additionalProperties: false,
          },
        },
      },
    });
    expect(Object.keys(manifest?.contract.signals ?? {})).toEqual(['approve', 'ping']);
  });

  it('keys message metadata by runtime definition names instead of builder aliases', async () => {
    engine = createEngine();
    const aliasedWorkflow = workflow({ name: 'aliased-messages' })
      .signals({ approveAlias: signal('approval') })
      .updates({ renameAlias: update('rename') })
      .queries({ statusAlias: query('status') })
      .execute(async function* () {});
    engine.register(aliasedWorkflow);

    const snapshot = await buildRegistrySnapshot(engine);
    const manifest = findManifest(snapshot, 'aliased-messages');

    expect(Object.keys(manifest?.contract.signals ?? {})).toEqual(['approval']);
    expect(Object.keys(manifest?.contract.updates ?? {})).toEqual(['rename']);
    expect(Object.keys(manifest?.contract.queries ?? {})).toEqual(['status']);
  });

  it('omits schema fields that are absent on the workflow registration', async () => {
    engine = createEngine();
    const schemalessWorkflow = workflow({ name: 'schemaless' }).execute(async function* () {});
    engine.register(schemalessWorkflow);

    const snapshot = await buildRegistrySnapshot(engine);
    const manifest = findManifest(snapshot, 'schemaless');
    expect(manifest).toBeDefined();
    expect(manifest?.contract).not.toHaveProperty('inputSchema');
    expect(manifest?.contract).not.toHaveProperty('outputSchema');
    expect(manifest?.contract).not.toHaveProperty('description');
  });

  it('includes only one schema when only the input schema is registered', async () => {
    engine = createEngine();
    const partialWorkflow = workflow({
      name: 'partial',
      inputSchema: z.object({ x: z.number() }),
    }).execute(async function* () {});
    engine.register(partialWorkflow);

    const snapshot = await buildRegistrySnapshot(engine);
    const manifest = findManifest(snapshot, 'partial');
    expect(manifest).toBeDefined();
    expect(manifest?.contract.inputSchema).toBeDefined();
    expect(manifest?.contract).not.toHaveProperty('outputSchema');
  });

  it('does not emit empty tags arrays', async () => {
    engine = createEngine();
    const untaggedWorkflow = workflow({ name: 'untagged' }).execute(async function* () {});
    engine.register(untaggedWorkflow);

    const snapshot = await buildRegistrySnapshot(engine);
    const manifest = findManifest(snapshot, 'untagged');
    expect(manifest?.contract).not.toHaveProperty('tags');
  });

  it('includes a registered definition-level finalizer schema on the workflow entry (WFT-5)', async () => {
    engine = createEngine();
    const cleanup = activity({
      name: 'cleanup',
      inputSchema: z.object({ sandboxId: z.string() }),
      outputSchema: z.boolean(),
      execute: async () => true,
    });
    engine.register(
      workflow({ name: 'provisioned', finalizer: cleanup }).execute(async function* () {}),
    );

    const snapshot = await buildRegistrySnapshot(engine);
    const manifest = findManifest(snapshot, 'provisioned');
    expect(manifest?.contract.finalizer?.inputSchema).toEqual({
      type: 'object',
      properties: { sandboxId: { type: 'string' } },
      required: ['sandboxId'],
      additionalProperties: false,
    });
    expect(manifest?.contract.finalizer?.outputSchema).toEqual({ type: 'boolean' });
  });

  it('omits the finalizer field entirely when no finalizer is registered', async () => {
    engine = createEngine();
    engine.register(workflow({ name: 'no-finalizer' }).execute(async function* () {}));

    const snapshot = await buildRegistrySnapshot(engine);
    const manifest = findManifest(snapshot, 'no-finalizer');
    expect(manifest?.contract).not.toHaveProperty('finalizer');
  });

  it('includes activities with queue, schemas, description, retry policy, and timeout', async () => {
    engine = createEngine();
    engine.register(
      activity({
        name: 'sendEmail',
        execute: async (input: { to: string }) => ({ delivered: true, recipient: input.to }),
        queue: 'mail',
        inputSchema: z.object({ to: z.string() }),
        outputSchema: z.object({ delivered: z.boolean(), recipient: z.string() }),
        description: 'Sends an email.',
        retry: {
          maxAttempts: 3,
          initialBackoff: '200ms',
          backoffMultiplier: 2,
          maxBackoff: '5s',
        },
        timeout: '30s',
      }),
    );

    const snapshot = await buildRegistrySnapshot(engine);
    expect(snapshot.activities['sendEmail']).toEqual({
      queue: 'mail',
      inputSchema: {
        type: 'object',
        properties: { to: { type: 'string' } },
        required: ['to'],
        additionalProperties: false,
      },
      outputSchema: {
        type: 'object',
        properties: {
          delivered: { type: 'boolean' },
          recipient: { type: 'string' },
        },
        required: ['delivered', 'recipient'],
        additionalProperties: false,
      },
      description: 'Sends an email.',
      retry: {
        maxAttempts: 3,
        initialBackoff: '200ms',
        backoffMultiplier: 2,
        maxBackoff: '5s',
      },
      timeout: '30s',
    });
  });

  it('omits activity schema fields that are absent on registration', async () => {
    engine = createEngine();
    engine.register(activity({ name: 'noop', execute: async () => undefined }));

    const snapshot = await buildRegistrySnapshot(engine);
    const entry = snapshot.activities['noop'];
    expect(entry).toBeDefined();
    expect(entry).not.toHaveProperty('inputSchema');
    expect(entry).not.toHaveProperty('outputSchema');
    expect(entry).not.toHaveProperty('description');
    // queue is always present (engine assigns a default)
    expect(typeof entry?.queue).toBe('string');
  });

  it('returns an empty registry when no workflows or activities are registered', async () => {
    engine = createEngine();
    const snapshot = await buildRegistrySnapshot(engine);
    expect(snapshot.workflows).toEqual([]);
    expect(snapshot.activeRevisions).toEqual({});
    expect(snapshot.activities).toEqual({});
  });

  it('orders workflow manifests alphabetically by name', async () => {
    engine = createEngine();
    const charlieWorkflow = workflow({ name: 'charlie' }).execute(async function* () {});
    engine.register(charlieWorkflow);
    const alphaWorkflow = workflow({ name: 'alpha' }).execute(async function* () {});
    engine.register(alphaWorkflow);
    const bravoWorkflow = workflow({ name: 'bravo' }).execute(async function* () {});
    engine.register(bravoWorkflow);

    const snapshot = await buildRegistrySnapshot(engine);
    expect(snapshot.workflows.map((m) => m.name)).toEqual(['alpha', 'bravo', 'charlie']);
  });

  it('orders activity keys alphabetically by codepoint', async () => {
    engine = createEngine();
    engine.register(activity({ name: 'xyz', execute: async () => undefined }));
    engine.register(activity({ name: 'abc', execute: async () => undefined }));
    engine.register(activity({ name: 'mno', execute: async () => undefined }));

    const snapshot = await buildRegistrySnapshot(engine);
    expect(Object.keys(snapshot.activities)).toEqual(['abc', 'mno', 'xyz']);
  });

  it('rejects integer-like names before they can affect registry snapshot ordering', async () => {
    engine = createEngine();

    expect(() => workflow({ name: '1' }).execute(async function* () {})).toThrow(
      'workflow name "1" is invalid',
    );
    expect(() => activity({ name: '1', execute: async () => undefined })).toThrow(
      'activity name "1" is invalid',
    );
    const structuralWorkflow: WorkflowDefinition = {
      name: '1',
      handler: async function* () {},
    };
    expect(() => engine?.register(structuralWorkflow)).toThrow('workflow name "1" is invalid');

    const directRegistry = new ActivityRegistry();
    expect(() => directRegistry.register('1', async () => undefined)).toThrow(
      'activity name "1" is invalid',
    );

    const snapshot = await buildRegistrySnapshot(engine);
    expect(snapshot.workflows).toEqual([]);
    expect(Object.keys(snapshot.activities)).toEqual([]);
  });

  it('throws RegistrySchemaConversionError with workflow context when input schema conversion fails', async () => {
    engine = createEngine();
    const brokenSchema = makeBrokenSchema('input');
    const brokenWorkflow = workflow({
      name: 'broken',
      inputSchema: brokenSchema,
    }).execute(async function* () {});
    engine.register(brokenWorkflow);

    await expect(buildRegistrySnapshot(engine)).rejects.toThrow(RegistrySchemaConversionError);
    let captured: unknown;
    try {
      await buildRegistrySnapshot(engine);
    } catch (error) {
      captured = error;
    }
    expect(captured).toBeInstanceOf(RegistrySchemaConversionError);
    const error = captured as RegistrySchemaConversionError;
    expect(error.entityKind).toBe('workflow');
    expect(error.entityName).toBe('broken');
    expect(error.direction).toBe('inputSchema');
    expect(error.message).toMatch(/Failed to convert inputSchema for workflow "broken"/);
  });

  it('throws RegistrySchemaConversionError with workflow context when output schema conversion fails', async () => {
    engine = createEngine();
    const brokenSchema = makeBrokenSchema('output');
    const brokenWorkflow2 = workflow({
      name: 'broken',
      outputSchema: brokenSchema,
    }).execute(async function* () {});
    engine.register(brokenWorkflow2);

    let captured: unknown;
    try {
      await buildRegistrySnapshot(engine);
    } catch (error) {
      captured = error;
    }
    expect(captured).toBeInstanceOf(RegistrySchemaConversionError);
    const error = captured as RegistrySchemaConversionError;
    expect(error.entityKind).toBe('workflow');
    expect(error.entityName).toBe('broken');
    expect(error.direction).toBe('outputSchema');
  });

  it('throws RegistrySchemaConversionError with activity context when input schema conversion fails', async () => {
    engine = createEngine();
    const brokenSchema = makeBrokenSchema('input');
    engine.register(
      activity({
        name: 'brokenActivity',
        execute: async () => undefined,
        inputSchema: brokenSchema,
      }),
    );

    let captured: unknown;
    try {
      await buildRegistrySnapshot(engine);
    } catch (error) {
      captured = error;
    }
    expect(captured).toBeInstanceOf(RegistrySchemaConversionError);
    const error = captured as RegistrySchemaConversionError;
    expect(error.entityKind).toBe('activity');
    expect(error.entityName).toBe('brokenActivity');
    expect(error.direction).toBe('inputSchema');
  });

  it('throws RegistrySchemaConversionError with activity context when output schema conversion fails', async () => {
    engine = createEngine();
    const brokenSchema = makeBrokenSchema('output');
    engine.register(
      activity({
        name: 'brokenActivity',
        execute: async () => undefined,
        outputSchema: brokenSchema,
      }),
    );

    let captured: unknown;
    try {
      await buildRegistrySnapshot(engine);
    } catch (error) {
      captured = error;
    }
    expect(captured).toBeInstanceOf(RegistrySchemaConversionError);
    const error = captured as RegistrySchemaConversionError;
    expect(error.entityKind).toBe('activity');
    expect(error.entityName).toBe('brokenActivity');
    expect(error.direction).toBe('outputSchema');
  });

  it('throws RegistryManifestLimitError when a registered workflow contract exceeds a WFT-5 limit', async () => {
    engine = createEngine();
    // Nothing in engine registration bounds `version` length, unlike the
    // manifest-building step this exercises — see MAX_CONTRACT_IDENTIFIER_BYTES.
    engine.register(
      workflow({ name: 'oversized', version: 'a'.repeat(600) }).execute(async function* () {}),
    );

    let captured: unknown;
    try {
      await buildRegistrySnapshot(engine);
    } catch (error) {
      captured = error;
    }
    expect(captured).toBeInstanceOf(RegistryManifestLimitError);
    const error = captured as RegistryManifestLimitError;
    expect(error.workflowType).toBe('oversized');
  });

  it('throws RegistryWorkflowCountLimitError before building any manifest when more than the maximum workflows are registered (WFT-6)', async () => {
    // `Engine.register()` enforces no aggregate ceiling, so this proves the
    // producer-side check fires: registering one more than
    // `MAX_REGISTRY_WORKFLOW_COUNT` throws before a single manifest is
    // built or hashed, so `weft codegen --server`'s matching consumer-side
    // ceiling in `cli/codegen-validate.ts` can never reject a snapshot this
    // function actually emits.
    engine = createEngine();
    for (let index = 0; index < MAX_REGISTRY_WORKFLOW_COUNT + 1; index += 1) {
      engine.register(workflow({ name: `workflow-${index}` }).execute(async function* () {}));
    }

    let captured: unknown;
    try {
      await buildRegistrySnapshot(engine);
    } catch (error) {
      captured = error;
    }
    expect(captured).toBeInstanceOf(RegistryWorkflowCountLimitError);
    const error = captured as RegistryWorkflowCountLimitError;
    expect(error.count).toBe(MAX_REGISTRY_WORKFLOW_COUNT + 1);
  });

  it('buildWorkflowManifestForType resolves one workflow without the aggregate workflow-count check, even when the engine exceeds it (WFT-6)', async () => {
    // `buildWorkerManifestFromRegistry` (`worker/manifest/registry-contract-builder.ts`)
    // relies on exactly this: it only looks up the handful of workflows its
    // own caller names, via `buildWorkflowManifestForType`, never the full
    // `buildRegistrySnapshot()`, so an engine with more than the ceiling's
    // worth of unrelated registrations must not block it.
    engine = createEngine();
    engine.register(workflow({ name: 'checkout' }).execute(async function* () {}));
    for (let index = 0; index < MAX_REGISTRY_WORKFLOW_COUNT; index += 1) {
      engine.register(workflow({ name: `workflow-${index}` }).execute(async function* () {}));
    }

    const manifest = await buildWorkflowManifestForType(engine, 'checkout');
    expect(manifest?.name).toBe('checkout');
  });

  it('buildWorkflowManifestForType returns undefined for an unregistered workflow type (WFT-6)', async () => {
    engine = createEngine();
    const manifest = await buildWorkflowManifestForType(engine, 'never-registered');
    expect(manifest).toBeUndefined();
  });

  it('does not include remote-only activities (workers without local registrations are excluded)', async () => {
    engine = createEngine();
    // Locally register one activity. A "remote-only" activity is one that exists only
    // on a connected worker, not in the engine's activity registry. Since
    // buildRegistrySnapshot only reads from engine.listActivityDefinitions(), there is
    // no path through which a remote-only name could leak into the snapshot.
    engine.register(activity({ name: 'local', execute: async () => undefined }));
    const snapshot = await buildRegistrySnapshot(engine);
    expect(Object.keys(snapshot.activities)).toEqual(['local']);
    // Sanity: a fictitious remote-only name must not appear.
    expect(snapshot.activities).not.toHaveProperty('remoteOnly');
  });

  it('safely handles workflows and activities named "__proto__"', async () => {
    // Plain `{}` objects treat assignment to `__proto__` as a prototype mutation
    // rather than an own property, which would silently drop the entry from
    // JSON output. Null-prototype maps store it as a normal property.
    engine = createEngine();
    const ProtoWorkflow = workflow({ name: '__proto__' }).execute(async function* () {});
    engine.register(ProtoWorkflow);
    engine.register(activity({ name: '__proto__', execute: async () => undefined }));

    const snapshot = await buildRegistrySnapshot(engine);
    expect(snapshot.workflows.map((m) => m.name)).toContain('__proto__');
    expect(Object.keys(snapshot.activities)).toContain('__proto__');
    expect(Object.keys(snapshot.activeRevisions)).toContain('__proto__');

    // The serialized JSON must also include the entries — this is the
    // observable contract for HTTP consumers.
    const serialized = JSON.parse(JSON.stringify(snapshot)) as {
      workflows: Array<{ name: string }>;
      activeRevisions: Record<string, unknown>;
      activities: Record<string, unknown>;
    };
    expect(serialized.workflows.some((m) => m.name === '__proto__')).toBe(true);
    expect(serialized.activeRevisions['__proto__']).toBeDefined();
    expect(serialized.activities['__proto__']).toBeDefined();
  });

  it('omits activity tags from the snapshot (tags do not surface in codegen function types)', async () => {
    // Documented contract: activity entries do not include `tags`. The codegen
    // CLI (the primary consumer) emits activities as TypeScript function types,
    // which have no place for tags. If the contract changes, this test will
    // start failing and the type/comment can be updated together.
    engine = createEngine();
    engine.register(
      activity({
        name: 'tagged',
        execute: async () => undefined,
        tags: ['observability', 'critical'],
      }),
    );

    const snapshot = await buildRegistrySnapshot(engine);
    expect(snapshot.activities['tagged']).not.toHaveProperty('tags');
  });

  it('folds a workflow-scoped activity schema into that workflow manifest’s contractHash and revision (WFT-6)', async () => {
    async function snapshotFor(inputSchema: z.ZodTypeAny) {
      const localEngine = createEngine();
      try {
        localEngine.register(
          workflow({ name: 'checkout' })
            .activities({
              charge: activity({
                name: 'charge',
                execute: async () => ({ ok: true }),
                inputSchema,
              }),
            })
            .execute(async function* () {}),
        );
        const snapshot = await buildRegistrySnapshot(localEngine);
        return findManifest(snapshot, 'checkout');
      } finally {
        localEngine[Symbol.dispose]();
      }
    }

    const before = await snapshotFor(z.object({ amountCents: z.number() }));
    const after = await snapshotFor(z.object({ amountUsd: z.string() }));

    expect(before).toBeDefined();
    expect(after).toBeDefined();
    // The scoped activity is part of the contract at all: absent from a
    // workflow with no `.activities({...})` step (asserted by the next
    // case), present here.
    expect(before?.contract.activities?.['charge']).toBeDefined();
    // Same workflow, same version, only the scoped activity's input schema
    // differs — contractHash and revision must both move, or a caller
    // resolving "the same contract, redeployed" could miss a real change to
    // what the workflow's own `.activities({...})` step accepts.
    expect(after?.contractHash).not.toBe(before?.contractHash);
    expect(after?.revision).not.toBe(before?.revision);
  });

  it('orders a workflow’s scoped activities alphabetically by name regardless of registration order', async () => {
    engine = createEngine();
    engine.register(
      workflow({ name: 'checkout' })
        .activities({
          refund: activity({ name: 'refund', execute: async () => undefined }),
          charge: activity({ name: 'charge', execute: async () => undefined }),
        })
        .execute(async function* () {}),
    );

    const snapshot = await buildRegistrySnapshot(engine);
    const manifest = findManifest(snapshot, 'checkout');
    expect(Object.keys(manifest?.contract.activities ?? {})).toEqual(['charge', 'refund']);
  });

  it('omits `contract.activities` for a workflow with no `.activities({...})` step', async () => {
    engine = createEngine();
    engine.register(workflow({ name: 'no-activities' }).execute(async function* () {}));

    const snapshot = await buildRegistrySnapshot(engine);
    const manifest = findManifest(snapshot, 'no-activities');
    expect(manifest?.contract.activities).toBeUndefined();
  });

  it('reads activeRevisions from the durable workflow catalog, not a recomputation off the manifest', async () => {
    engine = createEngine();
    engine.register(workflow({ name: 'catalog-backed' }).execute(async function* () {}));

    const snapshot = await buildRegistrySnapshot(engine);
    const catalog = getWorkflowCatalog(engine);
    const activePointer = catalog.resolveActive('catalog-backed');

    expect(activePointer).toBeDefined();
    expect(snapshot.activeRevisions['catalog-backed']).toBe(activePointer?.revision);
    // The catalog's own active pointer agrees exactly with what the builder's
    // agree-or-throw invariant assumes for the normal single-registration path.
    const manifest = findManifest(snapshot, 'catalog-backed');
    expect(manifest?.revision).toBe(activePointer?.revision);
  });

  it('throws the agree-or-throw invariant error when the catalog and the freshly built manifest disagree', async () => {
    engine = createEngine();
    engine.register(workflow({ name: 'diverged' }).execute(async function* () {}));
    // Drive one drain so the catalog activates the current ('1.0.0') revision.
    await buildRegistrySnapshot(engine);

    // Simulate a future dynamic-loading producer activating a DIFFERENT
    // revision directly on the catalog, without re-registering the engine's
    // own definition — this is exactly the divergence the invariant guards
    // against (see the JSDoc on the `activeRevisions` loop).
    // `activateRegistered` (unconditional, never compatibility-gated) is used
    // rather than `activateCandidate` specifically so an incompatible version
    // bump cannot be refused — this test needs the catalog to durably diverge.
    const catalog = getWorkflowCatalog(engine);
    const divergentManifest = await buildWorkflowRevisionManifest(
      buildWorkflowContract({ name: 'diverged', version: '2.0.0' }),
    );
    await catalog.activateRegistered('diverged', divergentManifest, {
      type: 'diverged',
      version: '2.0.0',
      tags: [],
    });

    await expect(buildRegistrySnapshot(engine)).rejects.toThrow(
      /Registry snapshot invariant violated/,
    );
  });
});

describe('compareWorkflowManifests', () => {
  it('orders by name first', () => {
    expect(
      compareWorkflowManifests({ name: 'a', revision: 'z' }, { name: 'b', revision: 'a' }),
    ).toBe(-1);
    expect(
      compareWorkflowManifests({ name: 'b', revision: 'a' }, { name: 'a', revision: 'z' }),
    ).toBe(1);
  });

  it('breaks ties on revision when names are equal', () => {
    // Unreachable through buildRegistrySnapshot itself (the engine registers
    // at most one implementation per workflow name), so this exercises the
    // comparator directly.
    expect(
      compareWorkflowManifests(
        { name: 'same', revision: 'sha256:aaa' },
        { name: 'same', revision: 'sha256:bbb' },
      ),
    ).toBe(-1);
    expect(
      compareWorkflowManifests(
        { name: 'same', revision: 'sha256:bbb' },
        { name: 'same', revision: 'sha256:aaa' },
      ),
    ).toBe(1);
    expect(
      compareWorkflowManifests(
        { name: 'same', revision: 'sha256:aaa' },
        { name: 'same', revision: 'sha256:aaa' },
      ),
    ).toBe(0);
  });
});

/**
 * Build a Standard Schema-compatible validator that fails conversion: it
 * declares an unknown vendor and exposes no `~standard.jsonSchema` converter,
 * so `definitionSchemaToJsonSchema` will throw.
 */
function makeBrokenSchema(label: string): {
  '~standard': {
    version: 1;
    vendor: string;
    validate: (value: unknown) => { value: unknown };
  };
} {
  return {
    '~standard': {
      version: 1,
      vendor: `unknown-${label}`,
      validate: (value: unknown) => ({ value }),
    },
  };
}
