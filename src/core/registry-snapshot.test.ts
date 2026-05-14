/**
 * Tests for the registry snapshot builder.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { MemoryStorage } from '../storage/memory.ts';
import { Engine } from './engine.ts';
import {
  buildRegistrySnapshot,
  REGISTRY_VERSION,
  RegistrySchemaConversionError,
} from './registry-snapshot.ts';
import { activity } from './types.ts';

function createEngine(): Engine {
  return new Engine({ storage: new MemoryStorage() });
}

describe('buildRegistrySnapshot', () => {
  let engine: Engine | undefined;

  afterEach(() => {
    engine?.[Symbol.dispose]();
    engine = undefined;
  });

  it('returns registryVersion 1', () => {
    engine = createEngine();
    const snapshot = buildRegistrySnapshot(engine);
    expect(snapshot.registryVersion).toBe(REGISTRY_VERSION);
    expect(snapshot.registryVersion).toBe(1);
  });

  it('includes workflows with their schema, description, and tags', () => {
    engine = createEngine();
    engine.register('welcome', {
      handler: async function* () {
        return { greeting: 'hi' };
      },
      inputSchema: z.object({ name: z.string() }),
      outputSchema: z.object({ greeting: z.string() }),
      description: 'Greets a person.',
      tags: ['greeting', 'demo'],
    });

    const snapshot = buildRegistrySnapshot(engine);

    expect(snapshot.workflows['welcome']).toEqual({
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
      description: 'Greets a person.',
      tags: ['greeting', 'demo'],
    });
  });

  it('omits schema fields that are absent on the workflow registration', () => {
    engine = createEngine();
    engine.register('schemaless', async function* () {});

    const snapshot = buildRegistrySnapshot(engine);

    const entry = snapshot.workflows['schemaless'];
    expect(entry).toBeDefined();
    expect(entry).not.toHaveProperty('inputSchema');
    expect(entry).not.toHaveProperty('outputSchema');
    expect(entry).not.toHaveProperty('description');
  });

  it('includes only one schema when only the input schema is registered', () => {
    engine = createEngine();
    engine.register('partial', {
      handler: async function* () {},
      inputSchema: z.object({ x: z.number() }),
    });

    const snapshot = buildRegistrySnapshot(engine);
    const entry = snapshot.workflows['partial'];
    expect(entry).toBeDefined();
    expect(entry?.inputSchema).toBeDefined();
    expect(entry).not.toHaveProperty('outputSchema');
  });

  it('does not emit empty tags arrays', () => {
    engine = createEngine();
    engine.register('untagged', async function* () {});

    const snapshot = buildRegistrySnapshot(engine);
    expect(snapshot.workflows['untagged']).not.toHaveProperty('tags');
  });

  it('includes activities with queue, schemas, and description', () => {
    engine = createEngine();
    engine.register(
      activity({
        name: 'sendEmail',
        execute: async (input: { to: string }) => ({ delivered: true, recipient: input.to }),
        queue: 'mail',
        inputSchema: z.object({ to: z.string() }),
        outputSchema: z.object({ delivered: z.boolean(), recipient: z.string() }),
        description: 'Sends an email.',
      }),
    );

    const snapshot = buildRegistrySnapshot(engine);
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
    });
  });

  it('omits activity schema fields that are absent on registration', () => {
    engine = createEngine();
    engine.register(activity({ name: 'noop', execute: async () => undefined }));

    const snapshot = buildRegistrySnapshot(engine);
    const entry = snapshot.activities['noop'];
    expect(entry).toBeDefined();
    expect(entry).not.toHaveProperty('inputSchema');
    expect(entry).not.toHaveProperty('outputSchema');
    expect(entry).not.toHaveProperty('description');
    // queue is always present (engine assigns a default)
    expect(typeof entry?.queue).toBe('string');
  });

  it('returns an empty registry when no workflows or activities are registered', () => {
    engine = createEngine();
    const snapshot = buildRegistrySnapshot(engine);
    expect(snapshot.workflows).toEqual({});
    expect(snapshot.activities).toEqual({});
  });

  it('orders workflow keys alphabetically by codepoint', () => {
    engine = createEngine();
    engine.register('charlie', async function* () {});
    engine.register('alpha', async function* () {});
    engine.register('bravo', async function* () {});

    const snapshot = buildRegistrySnapshot(engine);
    expect(Object.keys(snapshot.workflows)).toEqual(['alpha', 'bravo', 'charlie']);
  });

  it('orders activity keys alphabetically by codepoint', () => {
    engine = createEngine();
    engine.register(activity({ name: 'xyz', execute: async () => undefined }));
    engine.register(activity({ name: 'abc', execute: async () => undefined }));
    engine.register(activity({ name: 'mno', execute: async () => undefined }));

    const snapshot = buildRegistrySnapshot(engine);
    expect(Object.keys(snapshot.activities)).toEqual(['abc', 'mno', 'xyz']);
  });

  it('places integer-like keys first per ECMAScript object iteration semantics', () => {
    engine = createEngine();
    engine.register('alpha', async function* () {});
    engine.register('42', async function* () {});
    engine.register('beta', async function* () {});

    const snapshot = buildRegistrySnapshot(engine);
    // Per ECMAScript: integer-index keys come first in numeric order, then
    // string keys in insertion order. Our insertion is alphabetical, so the
    // observable order is: ["42", "alpha", "beta"].
    expect(Object.keys(snapshot.workflows)).toEqual(['42', 'alpha', 'beta']);
  });

  it('throws RegistrySchemaConversionError with workflow context when input schema conversion fails', () => {
    engine = createEngine();
    const brokenSchema = makeBrokenSchema('input');
    engine.register('broken', {
      handler: async function* () {},
      inputSchema: brokenSchema,
    });

    let captured: unknown;
    try {
      buildRegistrySnapshot(engine);
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

  it('throws RegistrySchemaConversionError with workflow context when output schema conversion fails', () => {
    engine = createEngine();
    const brokenSchema = makeBrokenSchema('output');
    engine.register('broken', {
      handler: async function* () {},
      outputSchema: brokenSchema,
    });

    let captured: unknown;
    try {
      buildRegistrySnapshot(engine);
    } catch (error) {
      captured = error;
    }
    expect(captured).toBeInstanceOf(RegistrySchemaConversionError);
    const error = captured as RegistrySchemaConversionError;
    expect(error.entityKind).toBe('workflow');
    expect(error.entityName).toBe('broken');
    expect(error.direction).toBe('outputSchema');
  });

  it('throws RegistrySchemaConversionError with activity context when input schema conversion fails', () => {
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
      buildRegistrySnapshot(engine);
    } catch (error) {
      captured = error;
    }
    expect(captured).toBeInstanceOf(RegistrySchemaConversionError);
    const error = captured as RegistrySchemaConversionError;
    expect(error.entityKind).toBe('activity');
    expect(error.entityName).toBe('brokenActivity');
    expect(error.direction).toBe('inputSchema');
  });

  it('throws RegistrySchemaConversionError with activity context when output schema conversion fails', () => {
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
      buildRegistrySnapshot(engine);
    } catch (error) {
      captured = error;
    }
    expect(captured).toBeInstanceOf(RegistrySchemaConversionError);
    const error = captured as RegistrySchemaConversionError;
    expect(error.entityKind).toBe('activity');
    expect(error.entityName).toBe('brokenActivity');
    expect(error.direction).toBe('outputSchema');
  });

  it('does not include remote-only activities (workers without local registrations are excluded)', () => {
    engine = createEngine();
    // Locally register one activity. A "remote-only" activity is one that exists only
    // on a connected worker, not in the engine's activity registry. Since
    // buildRegistrySnapshot only reads from engine.listActivityDefinitions(), there is
    // no path through which a remote-only name could leak into the snapshot.
    engine.register(activity({ name: 'local', execute: async () => undefined }));
    const snapshot = buildRegistrySnapshot(engine);
    expect(Object.keys(snapshot.activities)).toEqual(['local']);
    // Sanity: a fictitious remote-only name must not appear.
    expect(snapshot.activities).not.toHaveProperty('remoteOnly');
  });

  it('safely handles workflows and activities named "__proto__"', () => {
    // Plain `{}` objects treat assignment to `__proto__` as a prototype mutation
    // rather than an own property, which would silently drop the entry from
    // JSON output. Null-prototype maps store it as a normal property.
    engine = createEngine();
    engine.register('__proto__', { handler: async function* () {} });
    engine.register(activity({ name: '__proto__', execute: async () => undefined }));

    const snapshot = buildRegistrySnapshot(engine);
    expect(Object.keys(snapshot.workflows)).toContain('__proto__');
    expect(Object.keys(snapshot.activities)).toContain('__proto__');

    // The serialized JSON must also include the entries — this is the
    // observable contract for HTTP consumers.
    const serialized = JSON.parse(JSON.stringify(snapshot)) as {
      workflows: Record<string, unknown>;
      activities: Record<string, unknown>;
    };
    expect(serialized.workflows['__proto__']).toBeDefined();
    expect(serialized.activities['__proto__']).toBeDefined();
  });

  it('omits activity tags from the snapshot (tags do not surface in codegen function types)', () => {
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

    const snapshot = buildRegistrySnapshot(engine);
    expect(snapshot.activities['tagged']).not.toHaveProperty('tags');
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
