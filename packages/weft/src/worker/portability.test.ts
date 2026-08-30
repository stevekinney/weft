import { describe, expect, it } from 'bun:test';

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Verifies that RemoteWorker and LongPollWorker source files do not
 * contain direct `Bun.*` API calls (other than comments/JSDoc), ensuring
 * they are portable across JavaScript runtimes.
 */
describe('worker portability', () => {
  const workerDir = join(import.meta.dir);

  function readSource(filename: string): string {
    return readFileSync(join(workerDir, filename), 'utf-8');
  }

  function stripComments(source: string): string {
    // Remove single-line comments and multi-line comments.
    return source.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  }

  it('RemoteWorker (index.ts) has no direct Bun.* calls', () => {
    const source = stripComments(readSource('index.ts'));
    const matches = source.match(/\bBun\.\w+/g) ?? [];
    expect(matches).toEqual([]);
  });

  it('LongPollWorker (long-poll.ts) has no direct Bun.* calls', () => {
    const source = stripComments(readSource('long-poll.ts'));
    const matches = source.match(/\bBun\.\w+/g) ?? [];
    expect(matches).toEqual([]);
  });

  it('RemoteWorker imports sleep from portable runtime', () => {
    const source = readSource('index.ts');
    expect(source).toContain("from '../runtime/portable.ts'");
  });

  it('LongPollWorker imports sleep from portable runtime', () => {
    const source = readSource('long-poll.ts');
    expect(source).toContain("from '../runtime/portable.ts'");
  });
});
