import { describe, expect, it, spyOn } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { packPackage } from './validate-package-consumers.ts';

describe('packPackage', () => {
  it('uses the short npm filename output instead of the large JSON file inventory', () => {
    const directory = mkdtempSync(join(tmpdir(), 'weft-pack-contract-'));
    const filename = 'lostgradient-weft-0.27.13.tgz';
    writeFileSync(join(directory, filename), 'archive');
    const spawn = spyOn(Bun, 'spawnSync').mockReturnValue({
      exitCode: 0,
      stdout: Buffer.from(`${filename}\n`),
      stderr: Buffer.alloc(0),
    } as unknown as ReturnType<typeof Bun.spawnSync>);

    try {
      expect(packPackage(directory)).toBe(join(directory, filename));
      expect(spawn).toHaveBeenCalledWith(
        ['npm', 'pack', '--ignore-scripts', '--pack-destination', directory, '--silent'],
        expect.objectContaining({ stdout: 'pipe', stderr: 'pipe' }),
      );
    } finally {
      spawn.mockRestore();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('rejects JSON or multiple filenames instead of accepting ambiguous pack output', () => {
    const directory = mkdtempSync(join(tmpdir(), 'weft-pack-contract-'));
    const spawn = spyOn(Bun, 'spawnSync').mockReturnValue({
      exitCode: 0,
      stdout: Buffer.from('[{"filename":"lostgradient-weft-0.27.13.tgz"}]'),
      stderr: Buffer.alloc(0),
    } as unknown as ReturnType<typeof Bun.spawnSync>);

    try {
      expect(() => packPackage(directory)).toThrow('unexpected shape');
    } finally {
      spawn.mockRestore();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
