/**
 * Tests for the registry snapshot builder.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { MemoryStorage } from '../storage/memory.ts';
import { ActivityRegistry } from './activity-registry.ts';
import { Engine } from './engine.ts';
import {
  buildRegistrySnapshot,
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
