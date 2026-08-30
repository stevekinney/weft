import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { query, signal, update } from './message-handles.ts';

describe('signal()', () => {
  it('returns a definition with the given name', () => {
    const handle = signal<{ approved: boolean }>('approval');
    expect(handle.name).toBe('approval');
    expect(handle.inputSchema).toBeUndefined();
  });

  it('stores an inputSchema when supplied', () => {
    const schema = z.object({ approved: z.boolean() });
    const handle = signal('approval', { inputSchema: schema });
    expect(handle.inputSchema).toBe(schema);
  });

  it('rejects an inputSchema that is not Standard Schema-shaped', () => {
    expect(() => signal('approval', { inputSchema: { not: 'a schema' } as never })).toThrow(
      /Standard Schema-compatible/,
    );
  });
});

describe('update()', () => {
  it('returns a definition with the given name', () => {
    const handle = update<{ id: string }, { ok: true }>('approve');
    expect(handle.name).toBe('approve');
    expect(handle.inputSchema).toBeUndefined();
    expect(handle.outputSchema).toBeUndefined();
  });

  it('stores both inputSchema and outputSchema', () => {
    const inputSchema = z.object({ id: z.string() });
    const outputSchema = z.object({ ok: z.literal(true) });
    const handle = update('approve', { inputSchema, outputSchema });
    expect(handle.inputSchema).toBe(inputSchema);
    expect(handle.outputSchema).toBe(outputSchema);
  });

  it('rejects an invalid outputSchema', () => {
    const inputSchema = z.object({ id: z.string() });
    expect(() =>
      update('approve', {
        inputSchema,
        outputSchema: { not: 'a schema' } as never,
      }),
    ).toThrow(/Standard Schema-compatible/);
  });
});

describe('query()', () => {
  it('returns a definition with the given name', () => {
    const handle = query<void, { state: string }>('status');
    expect(handle.name).toBe('status');
  });

  it('stores both inputSchema and outputSchema', () => {
    const inputSchema = z.object({ id: z.string() });
    const outputSchema = z.object({ state: z.string() });
    const handle = query('status', { inputSchema, outputSchema });
    expect(handle.inputSchema).toBe(inputSchema);
    expect(handle.outputSchema).toBe(outputSchema);
  });

  it('rejects an invalid outputSchema', () => {
    expect(() => query('status', { outputSchema: { not: 'a schema' } as never })).toThrow(
      /Standard Schema-compatible/,
    );
  });

  it('rejects an invalid inputSchema', () => {
    expect(() => query('status', { inputSchema: { not: 'a schema' } as never })).toThrow(
      /Standard Schema-compatible/,
    );
  });
});
