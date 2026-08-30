import { describe, expect, it } from 'bun:test';

import { ActivityRegistry } from './activity-registry.ts';
import type { DefinitionSchema, RetryPolicy } from './types.ts';
import { activity } from './types.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFunction(): (input: unknown) => unknown {
  return (_input: unknown) => 'result';
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ActivityRegistry', () => {
  describe('register() and resolve()', () => {
    it('registers a function by name and resolves it back', () => {
      const registry = new ActivityRegistry();
      const fn = makeFunction();

      registry.register('greet', fn);

      expect(registry.resolve('greet')).toBe(fn);
    });

    it('returns undefined for an unregistered name', () => {
      const registry = new ActivityRegistry();

      expect(registry.resolve('nonexistent')).toBeUndefined();
    });

    it('overwrites a previous registration for the same name', () => {
      const registry = new ActivityRegistry();
      const first = makeFunction();
      const second = makeFunction();

      registry.register('greet', first);
      registry.register('greet', second);

      expect(registry.resolve('greet')).toBe(second);
    });
  });

  describe('has()', () => {
    it('returns true for a registered name', () => {
      const registry = new ActivityRegistry();
      registry.register('greet', makeFunction());

      expect(registry.has('greet')).toBe(true);
    });

    it('returns false for an unregistered name', () => {
      const registry = new ActivityRegistry();

      expect(registry.has('unknown')).toBe(false);
    });
  });

  describe('getMetadata()', () => {
    it('returns metadata keyed to the function reference', () => {
      const registry = new ActivityRegistry();
      const fn = makeFunction();

      registry.register('greet', fn, {
        queue: 'high-priority',
        timeout: '30 seconds',
        idempotent: true,
      });

      const metadata = registry.getMetadata(fn);
      expect(metadata).toBeDefined();
      expect(metadata!.name).toBe('greet');
      expect(metadata!.queue).toBe('high-priority');
      expect(metadata!.timeout).toBe('30 seconds');
      expect(metadata!.idempotent).toBe(true);
    });

    it('stores default values when no options are provided', () => {
      const registry = new ActivityRegistry();
      const fn = makeFunction();

      registry.register('greet', fn);

      const metadata = registry.getMetadata(fn);
      expect(metadata).toBeDefined();
      expect(metadata!.name).toBe('greet');
      expect(metadata!.queue).toBe('default');
      expect(metadata!.timeout).toBeUndefined();
      expect(metadata!.idempotent).toBeUndefined();
    });

    it('returns undefined for a function that was never registered', () => {
      const registry = new ActivityRegistry();

      expect(registry.getMetadata(makeFunction())).toBeUndefined();
    });

    it('stores a custom retry policy', () => {
      const registry = new ActivityRegistry();
      const fn = makeFunction();
      const retry: RetryPolicy = {
        maxAttempts: 5,
        initialBackoff: 500,
        backoffMultiplier: 1.5,
        maxBackoff: 10_000,
        nonRetryableErrors: ['ValidationError'],
      };

      registry.register('compute', fn, { retry });
      retry.nonRetryableErrors?.push('CallerMutation');

      const metadata = registry.getMetadata(fn);
      expect(metadata!.retry).toEqual({
        maxAttempts: 5,
        initialBackoff: 500,
        backoffMultiplier: 1.5,
        maxBackoff: 10_000,
        nonRetryableErrors: ['ValidationError'],
      });

      metadata!.retry!.nonRetryableErrors?.push('ReturnedMutation');

      expect(registry.getMetadata(fn)!.retry?.nonRetryableErrors).toEqual(['ValidationError']);
    });
  });

  describe('getMetadataByName()', () => {
    it('returns metadata by activity name', () => {
      const registry = new ActivityRegistry();
      const fn = makeFunction();

      registry.register('greet', fn, { queue: 'email' });

      const metadata = registry.getMetadataByName('greet');
      expect(metadata).toBeDefined();
      expect(metadata!.name).toBe('greet');
      expect(metadata!.queue).toBe('email');
    });

    it('returns undefined for an unregistered name', () => {
      const registry = new ActivityRegistry();

      expect(registry.getMetadataByName('unknown')).toBeUndefined();
    });
  });

  describe('auto-extraction from ActivityDefinition', () => {
    it('extracts metadata from an activity() definition registered by name', () => {
      const registry = new ActivityRegistry();
      const greet = activity({
        name: 'greet',
        execute: (input: string) => `Hello, ${input}!`,
        timeout: '30 seconds',
        queue: 'high-priority',
        idempotent: true,
        retry: {
          maxAttempts: 5,
          initialBackoff: 500,
          backoffMultiplier: 1.5,
          maxBackoff: 10_000,
        },
      });

      registry.register('greet', greet);

      const metadata = registry.getMetadata(greet);
      expect(metadata).toBeDefined();
      expect(metadata!.name).toBe('greet');
      expect(metadata!.timeout).toBe('30 seconds');
      expect(metadata!.queue).toBe('high-priority');
      expect(metadata!.idempotent).toBe(true);
      expect(metadata!.retry).toEqual({
        maxAttempts: 5,
        initialBackoff: 500,
        backoffMultiplier: 1.5,
        maxBackoff: 10_000,
      });
    });

    it('auto-extracts metadata when no explicit options are passed', () => {
      const registry = new ActivityRegistry();
      const greet = activity({
        name: 'greet',
        execute: (input: string) => `Hello, ${input}!`,
        queue: 'notifications',
      });

      // Register without explicit options — should auto-extract from the definition
      registry.register('greet', greet);

      const metadata = registry.getMetadata(greet);
      expect(metadata!.queue).toBe('notifications');
    });

    it('prefers explicit options over auto-extracted metadata', () => {
      const registry = new ActivityRegistry();
      const greet = activity({
        name: 'greet',
        execute: (input: string) => `Hello, ${input}!`,
        queue: 'from-definition',
      });

      registry.register('greet', greet, { queue: 'explicit-override' });

      const metadata = registry.getMetadata(greet);
      expect(metadata!.queue).toBe('explicit-override');
    });

    it('extracts catalog metadata from activity definitions', () => {
      const registry = new ActivityRegistry();
      const inputSchema = makeDefinitionSchema<string>();
      const outputSchema = makeDefinitionSchema<string>();
      const greet = activity({
        name: 'greet',
        description: 'Greets a user by name.',
        tags: ['public', 'examples'],
        inputSchema,
        outputSchema,
        execute: (input: string) => `Hello, ${input}!`,
      });

      registry.register('greet', greet);

      const metadata = registry.getMetadataByName('greet');
      expect(metadata).toMatchObject({
        name: 'greet',
        description: 'Greets a user by name.',
        tags: ['public', 'examples'],
      });
      expect(metadata?.inputSchema).toBe(inputSchema);
      expect(metadata?.outputSchema).toBe(outputSchema);
    });

    it('prefers explicit catalog metadata over activity definition metadata', () => {
      const registry = new ActivityRegistry();
      const definitionInputSchema = makeDefinitionSchema<string>();
      const explicitInputSchema = makeDefinitionSchema<{ id: string }>();
      const greet = activity({
        name: 'greet',
        description: 'From definition.',
        tags: ['definition'],
        inputSchema: definitionInputSchema,
        execute: (input: string) => `Hello, ${input}!`,
      });

      registry.register('greet', greet, {
        description: 'Explicit override.',
        tags: ['explicit'],
        inputSchema: explicitInputSchema,
      });

      const metadata = registry.getMetadataByName('greet');
      expect(metadata?.description).toBe('Explicit override.');
      expect(metadata?.tags).toEqual(['explicit']);
      expect(metadata?.inputSchema).toBe(explicitInputSchema);
    });

    it('rejects malformed explicit schema metadata', () => {
      const registry = new ActivityRegistry();
      const greet = activity({
        name: 'greet',
        execute: (input: string) => `Hello, ${input}!`,
      });

      expect(() =>
        registry.register('greet', greet, {
          inputSchema: {
            '~standard': {
              version: 1,
              validate: (value: unknown) => ({ value }),
            },
          } as unknown as DefinitionSchema,
        }),
      ).toThrow('activity registration "greet".inputSchema');

      expect(() =>
        registry.register('greet', greet, {
          outputSchema: {
            '~standard': {
              version: 1,
              vendor: '',
              validate: (value: unknown) => ({ value }),
            },
          } as unknown as DefinitionSchema,
        }),
      ).toThrow('activity registration "greet".outputSchema');
    });

    it('rejects malformed activity definition schema metadata', () => {
      const registry = new ActivityRegistry();

      const malformedInputSchemaActivity = activity({
        name: 'greet',
        inputSchema: {
          '~standard': {
            version: 1,
            validate: (value: unknown) => ({ value }),
          },
        } as unknown as DefinitionSchema<unknown, string>,
        execute: (input: string) => `Hello, ${input}!`,
      });

      expect(() => registry.register('greet', malformedInputSchemaActivity)).toThrow(
        'activity definition "greet".inputSchema',
      );

      const malformedOutputSchemaActivity = activity({
        name: 'format',
        outputSchema: {
          '~standard': {
            version: 1,
            vendor: '',
            validate: (value: unknown) => ({ value }),
          },
        } as unknown as DefinitionSchema<unknown, string>,
        execute: (input: string) => `Hello, ${input}!`,
      });

      expect(() => registry.register('format', malformedOutputSchemaActivity)).toThrow(
        'activity definition "format".outputSchema',
      );
    });
  });

  describe('unregister()', () => {
    it('removes a registration by name', () => {
      const registry = new ActivityRegistry();
      const fn = makeFunction();

      registry.register('greet', fn);
      registry.unregister('greet');

      expect(registry.has('greet')).toBe(false);
      expect(registry.resolve('greet')).toBeUndefined();
    });

    it('is a no-op for a name that was never registered', () => {
      const registry = new ActivityRegistry();

      // Should not throw
      registry.unregister('nonexistent');
    });

    it('keeps metadata when the same function remains registered under another name', () => {
      const registry = new ActivityRegistry();
      const fn = makeFunction();

      registry.register('primary', fn);
      registry.register('alias', fn);

      registry.unregister('primary');

      expect(registry.resolve('alias')).toBe(fn);
      expect(registry.getMetadata(fn)?.name).toBe('alias');
    });

    it('keeps per-name activity definitions stable when one function has aliases', () => {
      const registry = new ActivityRegistry();
      const fn = makeFunction();

      registry.register('primary', fn, {
        description: 'Primary definition.',
        tags: ['primary'],
      });
      registry.register('alias', fn, {
        description: 'Alias definition.',
        tags: ['alias'],
      });

      expect(registry.getDefinition('primary')).toMatchObject({
        name: 'primary',
        description: 'Primary definition.',
        tags: ['primary'],
      });
      expect(registry.getDefinition('alias')).toMatchObject({
        name: 'alias',
        description: 'Alias definition.',
        tags: ['alias'],
      });
      expect(registry.getMetadata(fn)?.name).toBe('alias');
    });

    it('retargets function metadata when an aliased name is registered to a different function', () => {
      const registry = new ActivityRegistry();
      const original = makeFunction();
      const replacement = makeFunction();

      registry.register('primary', original, {
        description: 'Primary definition.',
      });
      registry.register('alias', original, {
        description: 'Alias definition.',
      });
      registry.register('alias', replacement, {
        description: 'Replacement definition.',
      });

      expect(registry.getMetadata(original)).toMatchObject({
        name: 'primary',
        description: 'Primary definition.',
      });
      expect(registry.getMetadata(replacement)).toMatchObject({
        name: 'alias',
        description: 'Replacement definition.',
      });
      expect(registry.getDefinition('primary')?.name).toBe('primary');
      expect(registry.getDefinition('alias')?.name).toBe('alias');
    });
  });

  describe('names()', () => {
    it('returns all registered activity names', () => {
      const registry = new ActivityRegistry();
      registry.register('a', makeFunction());
      registry.register('b', makeFunction());
      registry.register('c', makeFunction());

      const names = [...registry.names()];
      expect(names.toSorted()).toEqual(['a', 'b', 'c']);
    });

    it('returns an empty iterator when nothing is registered', () => {
      const registry = new ActivityRegistry();

      expect([...registry.names()]).toEqual([]);
    });
  });

  describe('definition introspection', () => {
    it('returns isolated definition copies', () => {
      const registry = new ActivityRegistry();
      const tags = ['initial'];
      registry.register('greet', makeFunction(), {
        description: 'Greets a user.',
        tags,
      });

      tags.push('caller-mutation');
      const firstDefinition = registry.getDefinition('greet');
      expect(firstDefinition).toBeDefined();
      expect(firstDefinition?.tags).toEqual(['initial']);

      (firstDefinition!.tags as string[]).push('returned-mutation');

      expect(registry.getDefinition('greet')?.tags).toEqual(['initial']);
      expect(registry.listDefinitions()).toEqual([
        {
          name: 'greet',
          queue: 'default',
          description: 'Greets a user.',
          tags: ['initial'],
        },
      ]);
    });
  });
});
