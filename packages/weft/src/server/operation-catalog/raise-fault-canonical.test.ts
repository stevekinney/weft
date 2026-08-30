import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const OPERATIONS_DIR = new URL('../operations/', import.meta.url).pathname;

describe('raiseFault canonical path', () => {
  it('operation files route OperationFault literals through raiseFault', () => {
    const files = readdirSync(OPERATIONS_DIR).filter(
      (file) => file.endsWith('.ts') && !file.endsWith('.test.ts'),
    );
    const violations: string[] = [];

    for (const file of files) {
      const content = readFileSync(join(OPERATIONS_DIR, file), 'utf-8');
      // Match `throw { ... code: '...' }` even when the literal spans
      // multiple lines (a property on a line below `throw {` on its own).
      const hasDirectThrow = /throw\s*\{[\s\S]{0,400}?code:\s*['"]/.test(content);
      if (hasDirectThrow) {
        violations.push(file);
      }
    }

    expect(violations).toEqual([]);
  });
});
