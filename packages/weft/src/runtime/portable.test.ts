import { describe, expect, it } from 'bun:test';

import {
  detectRuntime,
  detectRuntimeVersion,
  fileSize,
  gunzipSync,
  gzipSync,
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
  describe('detectRuntime', () => {
    it('returns bun when running under Bun', () => {
      expect(detectRuntime()).toBe('bun');
    });

    it('returns node when Bun is unavailable but process.versions.node is present', async () => {
      await withRuntimeOverrides({ bun: undefined }, async () => {
        expect(detectRuntime()).toBe('node');
      });
    });

    it('returns browser when Bun is unavailable and window is present', async () => {
      await withRuntimeOverrides(
        {
          bun: undefined,
          process: undefined,
          window: {} as typeof globalThis.window,
        },
        async () => {
          expect(detectRuntime()).toBe('browser');
        },
      );
    });

    it('returns edge when Bun, Node, and browser globals are unavailable', async () => {
      await withRuntimeOverrides(
        {
          bun: undefined,
          process: undefined,
          window: undefined,
          document: undefined,
        },
        async () => {
          expect(detectRuntime()).toBe('edge');
        },
      );
    });
  });

  describe('detectRuntimeVersion', () => {
    it('returns Bun.version under Bun', () => {
      expect(detectRuntimeVersion()).toBe(Bun.version);
    });

    it('returns process.versions.node when Bun is unavailable but Node is present', async () => {
      await withRuntimeOverrides(
        { bun: undefined, process: { versions: { node: '20.11.0' } } as typeof globalThis.process },
        async () => {
          expect(detectRuntimeVersion()).toBe('20.11.0');
        },
      );
    });

    it('returns an empty string under a browser runtime', async () => {
      await withRuntimeOverrides(
        {
          bun: undefined,
          process: undefined,
          window: {} as typeof globalThis.window,
        },
        async () => {
          expect(detectRuntimeVersion()).toBe('');
        },
      );
    });

    it('returns an empty string under an edge runtime', async () => {
      await withRuntimeOverrides(
        {
          bun: undefined,
          process: undefined,
          window: undefined,
          document: undefined,
        },
        async () => {
          expect(detectRuntimeVersion()).toBe('');
        },
      );
    });
  });

  describe('sleep', () => {
    it('resolves after approximately the requested duration', async () => {
      const start = performance.now();
      await sleep(50);
      const elapsed = performance.now() - start;
      expect(elapsed).toBeGreaterThanOrEqual(40);
      expect(elapsed).toBeLessThan(200);
    });

    it('falls back to setTimeout when Bun is unavailable', async () => {
      await withRuntimeOverrides({ bun: undefined }, async () => {
        const start = performance.now();
        await sleep(10);
        const elapsed = performance.now() - start;
        expect(elapsed).toBeGreaterThanOrEqual(5);
      });
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

    it('returns 0 for a non-existent file under Bun', () => {
      // Bun.file().size returns 0 for missing files rather than throwing.
      const size = fileSize('/tmp/__does_not_exist_weft_test__');
      expect(size).toBe(0);
    });

    it('uses node:fs via process.getBuiltinModule when Bun is unavailable', async () => {
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

      await withRuntimeOverrides({ bun: undefined, process: processStub }, async () => {
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

      await withRuntimeOverrides({ bun: undefined, process: processStub }, async () => {
        expect(() => fileSize('/tmp/example')).toThrow(
          'fileSize() requires Bun or Node 22.5+ (process.getBuiltinModule). Not available in browser or edge runtimes.',
        );
      });
    });

    it('returns 0 for ENOENT on the Node fallback path', async () => {
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

      await withRuntimeOverrides({ bun: undefined, process: processStub }, async () => {
        expect(fileSize('/tmp/missing')).toBe(0);
      });
    });
  });

  describe('gzipSync / gunzipSync', () => {
    it('round-trips data correctly', () => {
      const original = new TextEncoder().encode('hello, compressed world!');
      const compressed = gzipSync(original);
      const decompressed = gunzipSync(compressed);
      expect(decompressed).toEqual(original);
    });

    it('produces output smaller than input for compressible data', () => {
      const data = new TextEncoder().encode('a'.repeat(1000));
      const compressed = gzipSync(data);
      expect(compressed.length).toBeLessThan(data.length);
    });

    it('handles empty input', () => {
      const empty = new Uint8Array(0);
      const compressed = gzipSync(empty);
      const decompressed = gunzipSync(compressed);
      expect(decompressed).toEqual(empty);
    });

    it('uses node:zlib via process.getBuiltinModule when Bun is unavailable', async () => {
      const processStub = {
        versions: { node: '22.5.0' },
        getBuiltinModule(id: string) {
          if (id === 'node:zlib') {
            return {
              gzipSync(data: Uint8Array) {
                return new Uint8Array([99, ...data]);
              },
              gunzipSync(data: Uint8Array) {
                return data.slice(1);
              },
            };
          }
          return undefined;
        },
      } as unknown as typeof globalThis.process;

      await withRuntimeOverrides({ bun: undefined, process: processStub }, async () => {
        const original = new Uint8Array([1, 2, 3]);
        const compressed = gzipSync(original);
        expect(compressed).toEqual(new Uint8Array([99, 1, 2, 3]));
        expect(gunzipSync(compressed)).toEqual(original);
      });
    });

    it('throws when gzip helpers are unavailable outside Bun and Node built-ins', async () => {
      const processStub = {
        versions: { node: '22.5.0' },
        getBuiltinModule() {
          return undefined;
        },
      } as unknown as typeof globalThis.process;

      await withRuntimeOverrides({ bun: undefined, process: processStub }, async () => {
        expect(() => gzipSync(new Uint8Array([1, 2, 3]))).toThrow(
          'gzip/gunzip require Bun or Node 22.5+ (process.getBuiltinModule). Not available in browser or edge runtimes — use CompressionStream directly.',
        );
      });
    });

    it('returns undefined from the built-in loader when process.getBuiltinModule is missing', async () => {
      const processStub = {
        versions: { node: '22.5.0' },
      } as typeof globalThis.process;

      await withRuntimeOverrides({ bun: undefined, process: processStub }, async () => {
        expect(() => fileSize('/tmp/example')).toThrow(
          'fileSize() requires Bun or Node 22.5+ (process.getBuiltinModule). Not available in browser or edge runtimes.',
        );
      });
    });

    it('rethrows non-ENOENT file system errors on the Node fallback path', async () => {
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

      await withRuntimeOverrides({ bun: undefined, process: processStub }, async () => {
        expect(() => fileSize('/tmp/example')).toThrow('permission denied');
      });
    });
  });
});
