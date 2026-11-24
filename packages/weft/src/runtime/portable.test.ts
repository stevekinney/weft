import { describe, expect, it } from 'bun:test';

import {
  fileSize,
  hashBytes,
  hashString,
  setPortableRuntimeTestOverridesForTesting,
  sleep,
} from './portable.ts';

async function withRuntimeOverrides(
  overrides: Parameters<typeof setPortableRuntimeTestOverridesForTesting>[0],
  callback: () => void | Promise<void>,
): Promise<void> {
  setPortableRuntimeTestOverridesForTesting(overrides);

  try {
    await callback();
  } finally {
    setPortableRuntimeTestOverridesForTesting(undefined);
  }
}

describe('portable runtime helpers', () => {
  describe('sleep', () => {
    it('resolves no earlier than the requested duration', async () => {
      const start = performance.now();
      // load-proof: the test asserts only a lower bound on the elapsed time, which load can only lengthen
      await sleep(50);
      const elapsed = performance.now() - start;
      expect(elapsed).toBeGreaterThanOrEqual(40);
    });
  });

  describe('sleep with a signal', () => {
    it('resolves immediately for a signal that is already aborted', async () => {
      const controller = new AbortController();
      controller.abort();
      // load-proof: a pre-aborted signal resolves without arming a timer, so no duration is involved
      await sleep(60_000, controller.signal);
    });

    it('ends early when the signal aborts, and leaves no pending timer', async () => {
      const controller = new AbortController();
      const pending = sleep(60_000, controller.signal);
      controller.abort();
      // load-proof: abort resolves the pause directly; the 60s timer is cleared, never awaited
      await pending;
    });

    it('still waits for the timer when the signal never aborts', async () => {
      const controller = new AbortController();
      const start = performance.now();
      // load-proof: the test asserts only a lower bound on the elapsed time, which load can only lengthen
      await sleep(30, controller.signal);
      expect(performance.now() - start).toBeGreaterThanOrEqual(20);
    });
  });

  describe('hashBytes', () => {
    it('returns a 16-character hex string', () => {
      const data = new Uint8Array([1, 2, 3, 4]);
      const result = hashBytes(data);
      expect(result).toHaveLength(16);
      expect(result).toMatch(/^[0-9a-f]{16}$/);
    });

    it('returns consistent results for the same input', () => {
      const data = new Uint8Array([10, 20, 30]);
      expect(hashBytes(data)).toBe(hashBytes(data));
    });

    it('returns different results for different inputs', () => {
      const a = new Uint8Array([1, 2, 3]);
      const b = new Uint8Array([4, 5, 6]);
      expect(hashBytes(a)).not.toBe(hashBytes(b));
    });

    it('handles empty input', () => {
      const result = hashBytes(new Uint8Array(0));
      expect(result).toHaveLength(16);
      expect(result).toMatch(/^[0-9a-f]{16}$/);
    });

    it('produces stable known values matching FNV-1a 64-bit reference', () => {
      // Pinned values from reference FNV-1a 64-bit implementation.
      expect(hashBytes(new Uint8Array([1, 2, 3, 4]))).toBe('be7a5e775165785d');
      // The empty input produces the FNV offset basis.
      expect(hashBytes(new Uint8Array(0))).toBe('cbf29ce484222325');
    });
  });

  describe('hashString', () => {
    it('returns a 16-character hex string', () => {
      const result = hashString('hello world');
      expect(result).toHaveLength(16);
      expect(result).toMatch(/^[0-9a-f]{16}$/);
    });

    it('returns consistent results for the same input', () => {
      expect(hashString('test')).toBe(hashString('test'));
    });

    it('returns different results for different inputs', () => {
      expect(hashString('foo')).not.toBe(hashString('bar'));
    });

    it('handles empty string', () => {
      const result = hashString('');
      expect(result).toHaveLength(16);
      expect(result).toMatch(/^[0-9a-f]{16}$/);
    });

    it('produces stable known values matching FNV-1a 64-bit reference', () => {
      expect(hashString('hello world')).toBe('779a65e7023cd2e7');
      // Empty input produces the FNV-1a 64-bit offset basis.
      expect(hashString('')).toBe('cbf29ce484222325');
      // Additional reference values from canonical FNV-1a 64-bit test vectors.
      expect(hashString('a')).toBe('af63dc4c8601ec8c');
      expect(hashString('foobar')).toBe('85944171f73967e8');
    });
  });

  describe('fileSize', () => {
    it('returns the byte size of an existing file', () => {
      // Use this test file itself — it definitely exists.
      const size = fileSize(import.meta.path);
      expect(size).toBeGreaterThan(0);
    });

    it('returns 0 for a non-existent file', () => {
      const size = fileSize('/tmp/__does_not_exist_weft_test__');
      expect(size).toBe(0);
    });

    it('uses node:fs via process.getBuiltinModule', async () => {
      const statSync = (path: string) => ({ size: path.length });
      const processStub = {
        versions: { node: '22.5.0' },
        getBuiltinModule(id: string) {
          if (id === 'node:fs') {
            return { statSync };
          }
          return undefined;
        },
      } as unknown as typeof globalThis.process;

      await withRuntimeOverrides({ process: processStub }, async () => {
        expect(fileSize('/tmp/example')).toBe(12);
      });
    });

    it('throws outside Bun and Node built-ins when fileSize is unavailable', async () => {
      const processStub = {
        versions: { node: '22.5.0' },
        getBuiltinModule() {
          return undefined;
        },
      } as unknown as typeof globalThis.process;

      await withRuntimeOverrides({ process: processStub }, async () => {
        expect(() => fileSize('/tmp/example')).toThrow(
          'fileSize() requires Bun or Node 22.5+ (process.getBuiltinModule). Not available in browser or edge runtimes.',
        );
      });
    });

    it('returns 0 for ENOENT from node:fs', async () => {
      const processStub = {
        versions: { node: '22.5.0' },
        getBuiltinModule(id: string) {
          if (id === 'node:fs') {
            return {
              statSync() {
                const error = new Error('missing') as Error & { code?: string };
                error.code = 'ENOENT';
                throw error;
              },
            };
          }
          return undefined;
        },
      } as unknown as typeof globalThis.process;

      await withRuntimeOverrides({ process: processStub }, async () => {
        expect(fileSize('/tmp/missing')).toBe(0);
      });
    });

    it('returns undefined from the built-in loader when process.getBuiltinModule is missing', async () => {
      const processStub = {
        versions: { node: '22.5.0' },
      } as typeof globalThis.process;

      await withRuntimeOverrides({ process: processStub }, async () => {
        expect(() => fileSize('/tmp/example')).toThrow(
          'fileSize() requires Bun or Node 22.5+ (process.getBuiltinModule). Not available in browser or edge runtimes.',
        );
      });
    });

    it('rethrows non-ENOENT file system errors from node:fs', async () => {
      const processStub = {
        versions: { node: '22.5.0' },
        getBuiltinModule(id: string) {
          if (id === 'node:fs') {
            return {
              statSync() {
                const error = new Error('permission denied') as Error & { code?: string };
                error.code = 'EACCES';
                throw error;
              },
            };
          }
          return undefined;
        },
      } as typeof globalThis.process;

      await withRuntimeOverrides({ process: processStub }, async () => {
        expect(() => fileSize('/tmp/example')).toThrow('permission denied');
      });
    });
  });
});
