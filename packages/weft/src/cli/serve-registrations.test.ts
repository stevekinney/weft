import { describe, expect, it } from 'bun:test';
import { Engine, workflow, type ActivityContext, type ActivityDefinition } from '../index.ts';
import { registerModuleExports, toActivityCallable } from './serve-registrations.ts';

describe('registerModuleExports', () => {
  it('registers workflow definitions under their canonical names', async () => {
    const definition = workflow({ name: 'canonical-name' }).execute(async function* () {
      yield* [];
      return 'done';
    });
    await using engine = new Engine();

    registerModuleExports(engine, { exportAlias: definition }, []);

    const handle = await engine.start('canonical-name', undefined);
    expect(handle.result()).resolves.toBe('done');
    expect(engine.start('exportAlias', undefined)).rejects.toThrow(
      'No workflow registered with name "exportAlias"',
    );
  });
});

describe('toActivityCallable', () => {
  it('preserves the activity name', () => {
    const definition: ActivityDefinition = {
      name: 'greet',
      execute: async (input: unknown) => `hello ${String(input)}`,
    };
    const callable = toActivityCallable(definition);
    expect(callable.name).toBe('greet');
  });

  it('delegates execution to the original execute function', async () => {
    const definition: ActivityDefinition = {
      name: 'doWork',
      execute: async (input: unknown) => `result:${String(input)}`,
    };
    const callable = toActivityCallable(definition);
    const result = await callable('test-input');
    expect(result).toBe('result:test-input');
  });

  it('attaches execute as an own property (required by engine.register)', () => {
    const definition: ActivityDefinition = {
      name: 'myActivity',
      execute: async () => 'done',
    };
    const callable = toActivityCallable(definition);
    expect(typeof callable.execute).toBe('function');
    expect(Object.prototype.hasOwnProperty.call(callable, 'execute')).toBe(true);
  });

  it('does not spread execute into metadata (execute is not duplicated in enumerable props)', () => {
    const definition: ActivityDefinition = {
      name: 'myActivity',
      description: 'A test activity',
      execute: async () => 'done',
    };
    const callable = toActivityCallable(definition);
    expect(callable.description).toBe('A test activity');
    // execute should be an own non-spread property, not appearing twice
    const ownKeys = Object.keys(callable);
    expect(ownKeys.filter((k) => k === 'execute').length).toBe(1);
  });

  it('preserves metadata fields (description, retry, queue, etc.)', () => {
    const definition: ActivityDefinition = {
      name: 'myActivity',
      description: 'Does something',
      queue: 'high-priority',
      execute: async () => null,
    };
    const callable = toActivityCallable(definition);
    expect(callable.description).toBe('Does something');
    expect(callable.queue).toBe('high-priority');
  });

  it('is callable as a function', async () => {
    const definition: ActivityDefinition = {
      name: 'add',
      execute: async (input: unknown) => {
        if (typeof input !== 'number') throw new TypeError('Expected a number');
        return input + 1;
      },
    };
    const callable = toActivityCallable(definition);
    expect(typeof callable).toBe('function');
    expect(await callable(41)).toBe(42);
  });

  it('forwards the original activity context and input unchanged', async () => {
    const heartbeats: unknown[] = [];
    const context: ActivityContext = {
      signal: new AbortController().signal,
      heartbeat(details) {
        heartbeats.push(details);
      },
      completeAsync() {
        throw new Error('Not requested by this activity');
      },
    };
    const input = { count: 42 };
    const definition: ActivityDefinition = {
      name: 'with-context',
      execute(value, receivedContext) {
        expect(value).toBe(input);
        expect(receivedContext).toBe(context);
        receivedContext?.heartbeat(value);
        return value;
      },
    };
    expect(await toActivityCallable(definition)(input, context)).toBe(input);
    expect(heartbeats).toEqual([input]);
  });
});
