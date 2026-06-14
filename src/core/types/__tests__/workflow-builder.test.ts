import { describe, expect, it } from 'bun:test';

import { activity } from '../activity.ts';
import { query, signal, update } from '../message-handles.ts';
import { WorkflowBuilderError, workflow } from '../workflow-function.ts';

describe('workflow() builder — name grammar', () => {
  it('accepts valid workflow names', () => {
    expect(() => workflow({ name: 'welcome' })).not.toThrow();
    expect(() => workflow({ name: 'good-name_1' })).not.toThrow();
  });

  it('rejects workflow names containing a dot', () => {
    expect(() => workflow({ name: 'bad.name' })).toThrow(/workflow name "bad\.name" /);
  });

  it('rejects workflow names starting with a digit', () => {
    expect(() => workflow({ name: '1bad' })).toThrow(/workflow name "1bad" /);
  });
});

describe('workflow() builder — chain method invariants', () => {
  it('allows each chain method once', () => {
    const built = workflow({ name: 'w' })
      .activities({ greet: async (input: string) => `hello ${input}` })
      .signals({ approve: signal<{ id: string }>('approve') })
      .updates({ check: update<{ id: string }, { ok: boolean }>('check') })
      .queries({ progress: query<void, number>('progress') })
      .searchAttributes({ customerId: { type: 'string' } })
      .services<{ repository: { load(id: string): Promise<string> } }>()
      .execute(async function* () {
        return 0;
      });
    expect(built.name).toBe('w');
    expect(Object.keys(built.activities)).toEqual(['greet']);
    expect(Object.keys(built.signals)).toEqual(['approve']);
    expect(Object.keys(built.updates)).toEqual(['check']);
    expect(Object.keys(built.queries)).toEqual(['progress']);
    expect(Object.keys(built.searchAttributes)).toEqual(['customerId']);
  });

  it('rejects duplicate .activities() calls', () => {
    const builder = workflow({ name: 'w' }).activities({ a: async () => 1 });
    expect(() =>
      (builder as unknown as { activities: (m: unknown) => unknown }).activities({
        b: async () => 2,
      }),
    ).toThrow(WorkflowBuilderError);
  });

  it('rejects duplicate .signals() calls', () => {
    const builder = workflow({ name: 'w' }).signals({ s: signal('s') });
    expect(() =>
      (builder as unknown as { signals: (m: unknown) => unknown }).signals({ s2: signal('s2') }),
    ).toThrow(WorkflowBuilderError);
  });

  it('rejects duplicate .services() calls', () => {
    const builder = workflow({ name: 'w' }).services<{ value: string }>();
    expect(() => (builder as unknown as { services: () => unknown }).services()).toThrow(
      WorkflowBuilderError,
    );
  });

  it('rejects .execute() twice', () => {
    const builder = workflow({ name: 'w' });
    builder.execute(async function* () {
      return 0;
    });
    expect(() =>
      builder.execute(async function* () {
        return 0;
      }),
    ).toThrow(WorkflowBuilderError);
  });

  it('rejects chain method calls after .execute()', () => {
    const builder = workflow({ name: 'w' });
    builder.execute(async function* () {
      return 0;
    });
    expect(() =>
      (builder as unknown as { activities: (m: unknown) => unknown }).activities({
        a: async () => 1,
      }),
    ).toThrow(WorkflowBuilderError);
  });
});

describe('workflow() builder — .activities() normalisation', () => {
  it('validates activity key grammar', () => {
    expect(() => workflow({ name: 'w' }).activities({ 'bad.name': async () => 1 })).toThrow(
      /activity name "bad\.name" /,
    );
  });

  it('accepts a bare async function', () => {
    const built = workflow({ name: 'w' })
      .activities({ greet: async (input: string) => `hello ${input}` })
      .execute(async function* () {
        return 0;
      });
    expect(built.activities['greet']!.name).toBe('greet');
    expect(typeof built.activities['greet']!.execute).toBe('function');
  });

  it('accepts a bare sync function', () => {
    const built = workflow({ name: 'w' })
      .activities({ upper: (input: string) => input.toUpperCase() })
      .execute(async function* () {
        return 0;
      });
    expect(built.activities['upper']!.name).toBe('upper');
  });

  it('accepts an activity() callable', () => {
    const greet = activity({ name: 'greet', execute: async (input: string) => input });
    const built = workflow({ name: 'w' })
      .activities({ greet })
      .execute(async function* () {
        return 0;
      });
    expect(built.activities['greet']!.name).toBe('greet');
  });

  it('accepts the object form with options', () => {
    const built = workflow({ name: 'w' })
      .activities({
        slow: {
          execute: async (input: string) => input,
          timeout: '5m',
          queue: 'heavy',
        },
      })
      .execute(async function* () {
        return 0;
      });
    expect(built.activities['slow']!.name).toBe('slow');
    expect(built.activities['slow']!.timeout).toBe('5m');
    expect(built.activities['slow']!.queue).toBe('heavy');
  });

  it('rejects inner name disagreeing with the outer key', () => {
    const misnamed = activity({ name: 'actuallyDifferent', execute: async (i: unknown) => i });
    expect(() => workflow({ name: 'w' }).activities({ greet: misnamed })).toThrow(
      WorkflowBuilderError,
    );
  });

  it('accepts inner name matching the outer key', () => {
    const greet = activity({ name: 'greet', execute: async (i: unknown) => i });
    expect(() => workflow({ name: 'w' }).activities({ greet })).not.toThrow();
  });
});

describe('workflow() builder — deep-freeze post-.execute()', () => {
  it('freezes the outer container fields', () => {
    const built = workflow({ name: 'w' })
      .activities({ greet: async (i: string) => i })
      .execute(async function* () {
        return 0;
      });
    expect(Object.isFrozen(built)).toBe(true);
    expect(Object.isFrozen(built.activities)).toBe(true);
    expect(Object.isFrozen(built.signals)).toBe(true);
    expect(Object.isFrozen(built.updates)).toBe(true);
    expect(Object.isFrozen(built.queries)).toBe(true);
    expect(Object.isFrozen(built.searchAttributes)).toBe(true);
  });

  it('rejects top-level mutation of an activity definition', () => {
    const built = workflow({ name: 'w' })
      .activities({ greet: async (i: string) => i })
      .execute(async function* () {
        return 0;
      });
    expect(() => {
      (built.activities['greet']! as { execute: unknown }).execute = () => 'hacked';
    }).toThrow(TypeError);
  });

  it('rejects nested mutation of retry policy', () => {
    const built = workflow({ name: 'w' })
      .activities({
        slow: {
          execute: async (i: string) => i,
          retry: { maxAttempts: 3, initialBackoff: '1s', backoffMultiplier: 2, maxBackoff: '10s' },
        },
      })
      .execute(async function* () {
        return 0;
      });
    expect(() => {
      (built.activities['slow']!.retry as { maxAttempts: number }).maxAttempts = 99;
    }).toThrow(TypeError);
  });

  it('rejects mutation of searchAttributes schema', () => {
    const built = workflow({ name: 'w' })
      .searchAttributes({ customerId: { type: 'string' } })
      .execute(async function* () {
        return 0;
      });
    expect(() => {
      (built.searchAttributes as Record<string, unknown>)['customerId'] = { type: 'integer' };
    }).toThrow(TypeError);
  });

  it('mutation of the user-supplied original map does not affect the built definition', () => {
    const originalMap = { greet: async (i: string) => i };
    const built = workflow({ name: 'w' })
      .activities(originalMap)
      .execute(async function* () {
        return 0;
      });
    // Mutate the original key — should not affect the built copy.
    (originalMap as Record<string, unknown>)['greet'] = () => 'hacked';
    expect(built.activities['greet']!.name).toBe('greet');
    expect(built.activities['greet']!.execute).not.toBe(
      (originalMap as Record<string, unknown>)['greet'],
    );
  });
});

describe('workflow() builder — handler shape', () => {
  it('returns a built definition whose handler invokes the user generator', async () => {
    const built = workflow({ name: 'w' }).execute(async function* (_ctx, input: number) {
      return input * 2;
    });
    expect(typeof built.handler).toBe('function');
    // Drive the generator manually to confirm it produces the user's return value.
    const generator = built.handler({} as never, 21);
    const result = await generator.next();
    expect(result.done).toBe(true);
    expect(result.value).toBe(42);
  });
});

describe('workflow() builder — passthrough options', () => {
  it('passes through version/description/tags/retention', () => {
    const built = workflow({
      name: 'w',
      version: '1.0.0',
      description: 'a test workflow',
      tags: ['x', 'y'],
      retention: { completed: '7d' },
    }).execute(async function* () {
      return 0;
    });
    expect(built.version).toBe('1.0.0');
    expect(built.description).toBe('a test workflow');
    expect(built.tags).toEqual(['x', 'y']);
    expect(built.retention).toEqual({ completed: '7d' });
  });
});
