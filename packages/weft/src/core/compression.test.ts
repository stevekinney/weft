import { describe, expect, it } from 'bun:test';

import { setPortableRuntimeTestOverridesForTesting } from '../runtime/portable.ts';
import {
  compressPayload,
  createBunCompressor,
  decompressPayload,
  resolveCompressionOptions,
} from './compression';

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

// ---------------------------------------------------------------------------
// resolveCompressionOptions
// ---------------------------------------------------------------------------

describe('resolveCompressionOptions', () => {
  it('applies defaults when called with no arguments', () => {
    const resolved = resolveCompressionOptions();
    expect(resolved).toEqual({ threshold: 4096, algorithm: 'gzip' });
  });

  it('applies defaults when called with an empty object', () => {
    const resolved = resolveCompressionOptions({});
    expect(resolved).toEqual({ threshold: 4096, algorithm: 'gzip' });
  });

  it('respects a custom threshold', () => {
    const resolved = resolveCompressionOptions({ threshold: 1024 });
    expect(resolved.threshold).toBe(1024);
    expect(resolved.algorithm).toBe('gzip');
  });

  it('respects a custom algorithm', () => {
    const resolved = resolveCompressionOptions({ algorithm: 'brotli' });
    expect(resolved.algorithm).toBe('brotli');
    expect(resolved.threshold).toBe(4096);
  });

  it('throws a clear error when brotli is requested without Bun or Node built-ins', async () => {
    const processStub = {
      versions: { node: '22.5.0' },
      getBuiltinModule() {
        return undefined;
      },
    } as unknown as typeof globalThis.process;

    await withRuntimeOverrides({ bun: undefined, process: processStub }, async () => {
      const compressor = createBunCompressor('brotli');
      expect(() => compressor.compress(new Uint8Array([1, 2, 3]))).toThrow(
        'Brotli compression requires Bun or Node 22.5+ with process.getBuiltinModule support. Use gzip compression for browser/edge runtimes.',
      );
    });
  });
});

// ---------------------------------------------------------------------------
// Round-trip: gzip
// ---------------------------------------------------------------------------

describe('gzip round-trip', () => {
  const compressor = createBunCompressor('gzip');

  it('round-trips data above the threshold', async () => {
    const original = new Uint8Array(8192).fill(42);
    const compressed = await compressPayload(original, compressor, 4096);
    const decompressed = await decompressPayload(compressed);
    expect(decompressed).toEqual(original);
  });

  it('round-trips data below the threshold (stored uncompressed)', async () => {
    const original = new Uint8Array(100).fill(7);
    const compressed = await compressPayload(original, compressor, 4096);
    const decompressed = await decompressPayload(compressed);
    expect(decompressed).toEqual(original);
  });
});

// ---------------------------------------------------------------------------
// Round-trip: brotli
// ---------------------------------------------------------------------------

describe('brotli round-trip', () => {
  const compressor = createBunCompressor('brotli');

  it('round-trips data above the threshold', async () => {
    const original = new Uint8Array(8192).fill(99);
    const compressed = await compressPayload(original, compressor, 4096);
    const decompressed = await decompressPayload(compressed);
    expect(decompressed).toEqual(original);
  });

  it('round-trips data below the threshold (stored uncompressed)', async () => {
    const original = new Uint8Array(100).fill(13);
    const compressed = await compressPayload(original, compressor, 4096);
    const decompressed = await decompressPayload(compressed);
    expect(decompressed).toEqual(original);
  });
});

// ---------------------------------------------------------------------------
// Round-trip: none
// ---------------------------------------------------------------------------

describe('none round-trip', () => {
  const compressor = createBunCompressor('none');

  it('returns the original payload from the none compressor', async () => {
    const original = new Uint8Array([1, 2, 3]);
    expect(await compressor.compress(original)).toBe(original);
  });

  it('round-trips data with magic + uncompressed header regardless of size', async () => {
    const original = new Uint8Array(8192).fill(55);
    const compressed = await compressPayload(original, compressor, 4096);
    expect(compressed[0]).toBe(0xc1);
    expect(compressed[1]).toBe(0x00);
    expect(compressed.length).toBe(original.length + 2);

    const decompressed = await decompressPayload(compressed);
    expect(decompressed).toEqual(original);
  });
});

// ---------------------------------------------------------------------------
// Threshold boundary behavior
// ---------------------------------------------------------------------------

describe('threshold boundary', () => {
  const compressor = createBunCompressor('gzip');

  it('does not compress data below the threshold', async () => {
    const data = new Uint8Array(4095).fill(1);
    const compressed = await compressPayload(data, compressor, 4096);
    expect(compressed[0]).toBe(0xc1);
    expect(compressed[1]).toBe(0x00);
    // Uncompressed: 2-byte header + original data
    expect(compressed.length).toBe(data.length + 2);
  });

  it('compresses data at exactly the threshold', async () => {
    const data = new Uint8Array(4096).fill(1);
    const compressed = await compressPayload(data, compressor, 4096);
    expect(compressed[0]).toBe(0xc1);
    expect(compressed[1]).toBe(0x01);
    // Repetitive data should compress significantly
    expect(compressed.length).toBeLessThan(data.length);
  });

  it('compresses data above the threshold', async () => {
    const data = new Uint8Array(8192).fill(1);
    const compressed = await compressPayload(data, compressor, 4096);
    expect(compressed[0]).toBe(0xc1);
    expect(compressed[1]).toBe(0x01);
    expect(compressed.length).toBeLessThan(data.length);
  });
});

// ---------------------------------------------------------------------------
// Cross-algorithm reads
// ---------------------------------------------------------------------------

describe('cross-algorithm reads', () => {
  it('reads gzip-compressed data even when current algorithm is brotli', async () => {
    const gzipCompressor = createBunCompressor('gzip');
    const original = new Uint8Array(8192).fill(77);
    const compressed = await compressPayload(original, gzipCompressor, 4096);
    expect(compressed[0]).toBe(0xc1);
    expect(compressed[1]).toBe(0x01); // gzip algorithm byte

    // decompressPayload uses the header bytes, not a configured algorithm
    const decompressed = await decompressPayload(compressed);
    expect(decompressed).toEqual(original);
  });

  it('reads brotli-compressed data even when current algorithm is gzip', async () => {
    const brotliCompressor = createBunCompressor('brotli');
    const original = new Uint8Array(8192).fill(33);
    const compressed = await compressPayload(original, brotliCompressor, 4096);
    expect(compressed[0]).toBe(0xc1);
    expect(compressed[1]).toBe(0x02); // brotli algorithm byte

    const decompressed = await decompressPayload(compressed);
    expect(decompressed).toEqual(original);
  });
});

describe('compression fallbacks', () => {
  it('falls back to uncompressed framing when compression expands the payload', async () => {
    const original = new Uint8Array([1, 2, 3, 4]);
    const expandingCompressor = {
      algorithm: 'gzip' as const,
      async compress(): Promise<Uint8Array> {
        return new Uint8Array([9, 9, 9, 9, 9, 9]);
      },
    };

    const compressed = await compressPayload(original, expandingCompressor, 0);

    expect(compressed[0]).toBe(0xc1);
    expect(compressed[1]).toBe(0x00);
    expect(await decompressPayload(compressed)).toEqual(original);
  });
});

// ---------------------------------------------------------------------------
// Malformed data (no canonical header)
// ---------------------------------------------------------------------------

describe('malformed payloads without a canonical header', () => {
  it('rejects raw msgpack data starting with 0x80+', async () => {
    const headerless = new Uint8Array([0x80, 0xa1, 0x61, 0x01]);
    await expect(decompressPayload(headerless)).rejects.toThrow(
      'Compression payload missing magic byte 0xC1.',
    );
  });

  it('rejects data with an arbitrary unrecognized first byte', async () => {
    const headerless = new Uint8Array([0xff, 0xab, 0xcd]);
    await expect(decompressPayload(headerless)).rejects.toThrow(
      'Compression payload missing magic byte 0xC1.',
    );
  });

  it('rejects single-byte payloads because they cannot contain the full header', async () => {
    await expect(decompressPayload(new Uint8Array([0x00]))).rejects.toThrow(
      'Compression payload missing 2-byte header.',
    );
  });

  it('rejects an unknown algorithm byte after the magic byte', async () => {
    await expect(decompressPayload(new Uint8Array([0xc1, 0x7f, 0x01]))).rejects.toThrow(
      'Compression payload uses unsupported algorithm byte 0x7f.',
    );
  });
});

// ---------------------------------------------------------------------------
// Empty data
// ---------------------------------------------------------------------------

describe('empty data', () => {
  it('round-trips an empty Uint8Array', async () => {
    const compressor = createBunCompressor('gzip');
    const original = new Uint8Array(0);
    const compressed = await compressPayload(original, compressor, 4096);
    // Below threshold → magic + uncompressed header
    expect(compressed[0]).toBe(0xc1);
    expect(compressed[1]).toBe(0x00);
    expect(compressed.length).toBe(2);

    const decompressed = await decompressPayload(compressed);
    expect(decompressed).toEqual(original);
  });

  it('rejects empty unframed data when decompressing', async () => {
    await expect(decompressPayload(new Uint8Array(0))).rejects.toThrow(
      'Compression payload missing 2-byte header.',
    );
  });

  it('rejects single-byte unframed data when decompressing', async () => {
    await expect(decompressPayload(new Uint8Array([0x42]))).rejects.toThrow(
      'Compression payload missing 2-byte header.',
    );
  });
});

// ---------------------------------------------------------------------------
// Large payload actually reduces size
// ---------------------------------------------------------------------------

describe('compression effectiveness', () => {
  it('reduces the size of a large repetitive payload with gzip', async () => {
    const compressor = createBunCompressor('gzip');
    // 100KB of repetitive data
    const original = new Uint8Array(102_400);
    for (let i = 0; i < original.length; i++) {
      original[i] = i % 256;
    }
    const compressed = await compressPayload(original, compressor, 4096);
    expect(compressed.length).toBeLessThan(original.length);
    // Verify it still round-trips
    const decompressed = await decompressPayload(compressed);
    expect(decompressed).toEqual(original);
  });

  it('reduces the size of a large repetitive payload with brotli', async () => {
    const compressor = createBunCompressor('brotli');
    const original = new Uint8Array(102_400);
    for (let i = 0; i < original.length; i++) {
      original[i] = i % 256;
    }
    const compressed = await compressPayload(original, compressor, 4096);
    expect(compressed.length).toBeLessThan(original.length);
    const decompressed = await decompressPayload(compressed);
    expect(decompressed).toEqual(original);
  });
});

// ---------------------------------------------------------------------------
// Header bytes are correct
// ---------------------------------------------------------------------------

describe('header byte values', () => {
  it('always starts with magic byte 0xC1', async () => {
    const compressor = createBunCompressor('gzip');
    const small = new Uint8Array(10).fill(1);
    const result = await compressPayload(small, compressor, 4096);
    expect(result[0]).toBe(0xc1);
  });

  it('uses algorithm byte 0x00 for uncompressed', async () => {
    const compressor = createBunCompressor('gzip');
    const small = new Uint8Array(10).fill(1);
    const result = await compressPayload(small, compressor, 4096);
    expect(result[0]).toBe(0xc1);
    expect(result[1]).toBe(0x00);
  });

  it('uses algorithm byte 0x01 for gzip', async () => {
    const compressor = createBunCompressor('gzip');
    const large = new Uint8Array(8192).fill(1);
    const result = await compressPayload(large, compressor, 4096);
    expect(result[0]).toBe(0xc1);
    expect(result[1]).toBe(0x01);
  });

  it('uses algorithm byte 0x02 for brotli', async () => {
    const compressor = createBunCompressor('brotli');
    const large = new Uint8Array(8192).fill(1);
    const result = await compressPayload(large, compressor, 4096);
    expect(result[0]).toBe(0xc1);
    expect(result[1]).toBe(0x02);
  });
});
