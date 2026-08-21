import { describe, expect, it } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

import {
  resolveRealNodeExecutable,
  sanitizeNodeEnv,
  sanitizeNodePath,
} from './resolve-real-node.ts';

const repositoryPath = join(import.meta.dir, '..', '..');

// Fakes ignore whatever `--eval <script>` arguments they're invoked with and
// just print a fixed `process.versions`-shaped payload — this lets the tests
// below exercise resolveRealNodeExecutable's own decision logic without
// depending on a genuine Node.js binary being present on the test-running
// machine (or, worse, on that machine's own version-manager shim behavior,
// which is exactly the class of flakiness this module exists to prevent).
function writeFakeVersionsExecutable(path: string, versionsJson: string): void {
  writeFileSync(path, `#!/bin/sh\necho '${versionsJson}'\n`);
  chmodSync(path, 0o755);
}

describe('sanitizeNodePath', () => {
  it('strips directories containing bun-node-', () => {
    const input = ['/usr/bin', '/tmp/bun-node-abc123', '/opt/homebrew/bin'].join(delimiter);

    expect(sanitizeNodePath(input)).toBe(['/usr/bin', '/opt/homebrew/bin'].join(delimiter));
  });

  it('leaves a path with no bun-node- entries unchanged', () => {
    const input = ['/usr/bin', '/opt/homebrew/bin'].join(delimiter);

    expect(sanitizeNodePath(input)).toBe(input);
  });
});

describe('sanitizeNodeEnv', () => {
  it('sanitizes only the PATH entry, preserving other env values', () => {
    const env = {
      PATH: ['/usr/bin', '/tmp/bun-node-abc123'].join(delimiter),
      HOME: '/Users/example',
    };

    expect(sanitizeNodeEnv(env)).toEqual({ PATH: '/usr/bin', HOME: '/Users/example' });
  });

  it('treats a missing PATH as empty', () => {
    expect(sanitizeNodeEnv({ HOME: '/Users/example' })).toEqual({
      PATH: '',
      HOME: '/Users/example',
    });
  });
});

describe('resolveRealNodeExecutable', () => {
  it('accepts a candidate that reports genuine Node process.versions', () => {
    const directory = mkdtempSync(join(tmpdir(), 'resolve-real-node-'));
    try {
      const nodePath = join(directory, 'node');
      writeFakeVersionsExecutable(nodePath, '{"node":"22.10.0"}');

      const resolved = resolveRealNodeExecutable({ PATH: directory }, repositoryPath);

      expect(resolved).not.toBeNull();
      expect(resolved?.executable).toBe(nodePath);
      expect(resolved?.env.PATH).toBe(directory);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('rejects a candidate that reports a bun version (a Bun-compat shim in disguise)', () => {
    const directory = mkdtempSync(join(tmpdir(), 'resolve-real-node-'));
    try {
      writeFakeVersionsExecutable(join(directory, 'node'), '{"node":"24.3.0","bun":"1.3.14"}');

      expect(resolveRealNodeExecutable({ PATH: directory }, repositoryPath)).toBeNull();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('rejects a candidate whose output is not valid process.versions JSON', () => {
    const directory = mkdtempSync(join(tmpdir(), 'resolve-real-node-'));
    try {
      const nodePath = join(directory, 'node');
      writeFileSync(nodePath, '#!/bin/sh\necho "not json"\n');
      chmodSync(nodePath, 0o755);

      expect(resolveRealNodeExecutable({ PATH: directory }, repositoryPath)).toBeNull();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('skips a rejected candidate and finds a valid one later on PATH', () => {
    const shimDirectory = mkdtempSync(join(tmpdir(), 'resolve-real-node-shim-'));
    const realDirectory = mkdtempSync(join(tmpdir(), 'resolve-real-node-real-'));
    try {
      writeFakeVersionsExecutable(join(shimDirectory, 'node'), '{"node":"24.3.0","bun":"1.3.14"}');

      const realNodePath = join(realDirectory, 'node');
      writeFakeVersionsExecutable(realNodePath, '{"node":"22.10.0"}');

      const path = [shimDirectory, realDirectory].join(delimiter);
      const resolved = resolveRealNodeExecutable({ PATH: path }, repositoryPath);

      expect(resolved?.executable).toBe(realNodePath);
    } finally {
      rmSync(shimDirectory, { recursive: true, force: true });
      rmSync(realDirectory, { recursive: true, force: true });
    }
  });

  it('ignores a PATH directory literally named with a bun-node- prefix', () => {
    const shimDirectory = mkdtempSync(join(tmpdir(), 'bun-node-fixture-'));
    try {
      writeFakeVersionsExecutable(join(shimDirectory, 'node'), '{"node":"22.10.0"}');

      expect(resolveRealNodeExecutable({ PATH: shimDirectory }, repositoryPath)).toBeNull();
    } finally {
      rmSync(shimDirectory, { recursive: true, force: true });
    }
  });

  it('returns null when no node executable is found on PATH', () => {
    const directory = mkdtempSync(join(tmpdir(), 'resolve-real-node-empty-'));
    mkdirSync(directory, { recursive: true });
    try {
      expect(resolveRealNodeExecutable({ PATH: directory }, repositoryPath)).toBeNull();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
