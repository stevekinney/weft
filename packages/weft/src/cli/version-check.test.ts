import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { KEYS, encode } from '../index.ts';
import { createStorage } from './index.ts';
import { executeVersionCheck } from './version-check.ts';

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('executeVersionCheck text output', () => {
  it('prints the formatted report instead of JSON when JSON output is not requested', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'weft-version-check-text-'));
    directories.push(directory);
    const database = join(directory, 'weft.db');
    const workflows = join(directory, 'module.ts');
    const storage = await createStorage('sqlite', database);

    try {
      await storage.put(
        KEYS.workflow('wf-version-check-text'),
        encode({
          id: 'wf-version-check-text',
          type: 'order',
          status: 'running',
          input: null,
          version: '1.0.0',
          createdAt: Date.now(),
          updatedAt: Date.now(),
        }),
      );
    } finally {
      storage[Symbol.dispose]();
    }
    await Bun.write(
      workflows,
      [
        'export default {',
        '  order: {',
        '    name: "order",',
        '    version: "1.0.0",',
        '    handler: async function* () {',
        '      return null;',
        '    },',
        '  },',
        '};',
      ].join('\n'),
    );

    const result = await executeVersionCheck({ database, workflows, json: false });

    expect(result.exitCode).toBe(0);
    expect(() => JSON.parse(result.stdout)).toThrow();
    expect(result.stdout).toContain('order');
    expect(result.stdout).toContain('1.0.0');
  });
});
