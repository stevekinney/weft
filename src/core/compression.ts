/**
 * Payload compression utilities for transparent gzip/brotli compression
 * at the storage layer. Uses a 2-byte header (magic byte `0xC1` + algorithm
 * byte) for format detection and cross-algorithm reads.
 *
 * @module core/compression
 */

import { gunzipSync, gzipSync, tryLoadNodeZlib } from '../runtime/portable.ts';

// ---------------------------------------------------------------------------
// Brotli — lazy-loaded from node:zlib via the portable runtime layer.
// Available in Bun and Node 22.5+; not available in browsers (throws).
// ---------------------------------------------------------------------------

function getBrotliZlib(): typeof import('node:zlib') {
  const zlib = tryLoadNodeZlib();
  if (!zlib) {
    throw new Error(
      'Brotli compression requires Bun or Node 22.5+ with process.getBuiltinModule support. ' +
        'Use gzip compression for browser/edge runtimes.',
    );
  }
  return zlib;
}

function brotliCompressSync(data: Uint8Array): Uint8Array {
  return new Uint8Array(getBrotliZlib().brotliCompressSync(data));
}

function brotliDecompressSync(data: Uint8Array): Uint8Array {
  return new Uint8Array(getBrotliZlib().brotliDecompressSync(data));
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Identifies the compression algorithm applied to storage payloads.
 * `'gzip'` and `'brotli'` compress before storage; `'none'` disables
 * compression. Pass to {@link EngineOptions.compression} or to
 * {@link createCompressor}.
 *
 * @example
 * ```ts
 * import { createCompressor, type CompressionAlgorithm } from '@lostgradient/weft';
 *
 * const algorithm: CompressionAlgorithm = 'brotli';
 * const compressor = createCompressor(algorithm);
 * const data = new TextEncoder().encode('payload'.repeat(100));
 * const compressed = compressor.compress(data);
 * console.log(compressed instanceof Uint8Array); // true
 * ```
 */
export type CompressionAlgorithm = 'gzip' | 'brotli' | 'none';

/**
 * Configuration for storage-layer compression. Pass as
 * {@link EngineOptions.compression} to enable payload compression on
 * checkpoints and activity results. `threshold` prevents compression of
 * small payloads (default 4 096 bytes); `algorithm` picks the codec.
 *
 * @example
 * ```ts
 * import { Engine, type CompressionOptions } from '@lostgradient/weft';
 *
 * const compression: CompressionOptions = {
 *   algorithm: 'brotli',
 *   threshold: 8_192,
 * };
 * const engine = new Engine({ compression });
 * void engine;
 * ```
 */
export type CompressionOptions = {
  /** Minimum size in bytes before compression kicks in. Default: 4096. */
  threshold?: number;
  /** Algorithm to use. Default: 'gzip'. */
  algorithm?: CompressionAlgorithm;
};

/**
 * A compression implementation returned by {@link createCompressor} or
 * {@link createBunCompressor}. The `compress` method accepts raw bytes
 * and returns compressed bytes (or a promise). Provide a custom
 * `Compressor` if you need to swap in a different algorithm.
 *
 * @example
 * ```ts
 * import { createCompressor, type Compressor } from '@lostgradient/weft';
 *
 * const compressor: Compressor = createCompressor('gzip');
 * const payload = new TextEncoder().encode('hello'.repeat(200));
 * const compressed = await compressor.compress(payload);
 * console.log(compressor.algorithm);            // 'gzip'
 * console.log(compressed.byteLength < payload.byteLength); // true
 * ```
 */
export type Compressor = {
  compress(data: Uint8Array): Uint8Array | Promise<Uint8Array>;
  readonly algorithm: CompressionAlgorithm;
};

// ---------------------------------------------------------------------------
// Header constants
// ---------------------------------------------------------------------------

/**
 * Magic byte that prefixes all compressed-storage payloads. Uses msgpack's
 * reserved `0xC1` byte, which is defined as "never used" in the msgpack
 * specification and will never appear as the first byte of valid msgpack data
 * written directly into storage.
 */
const MAGIC_BYTE = 0xc1;

/** Algorithm byte indicating the payload is stored uncompressed (with header). */
const ALGORITHM_UNCOMPRESSED = 0x00;

/** Algorithm byte indicating gzip compression. */
const ALGORITHM_GZIP = 0x01;

/** Algorithm byte indicating brotli compression. */
const ALGORITHM_BROTLI = 0x02;

/** The total header size: magic byte + algorithm byte. */
const HEADER_SIZE = 2;

// ---------------------------------------------------------------------------
// Compressor factory
// ---------------------------------------------------------------------------

/**
 * Create a compressor backed by the portable runtime layer.
 *
 * - `gzip`: uses Bun's native gzip when available, otherwise `node:zlib`
 * - `brotli`: uses `node:zlib` brotli (available in both Bun and Node)
 * - `none`: pass-through (no compression)
 *
 * @example
 * ```ts
 * import { createBunCompressor } from '@lostgradient/weft';
 *
 * const compressor = createBunCompressor('gzip');
 * const data = new TextEncoder().encode('hello world'.repeat(100));
 * const compressed = await compressor.compress(data);
 * console.log(compressed.byteLength < data.byteLength); // true
 * ```
 */
export function createBunCompressor(algorithm: CompressionAlgorithm): Compressor {
  return createCompressor(algorithm);
}

/**
 * Create a compressor. Preferred portable factory — delegates to the runtime
 * abstraction layer for gzip and brotli implementations.
 *
 * @example
 * ```ts
 * import { createCompressor } from '@lostgradient/weft';
 *
 * const gzip = createCompressor('gzip');
 * const brotli = createCompressor('brotli');
 * const none = createCompressor('none');
 *
 * const payload = new TextEncoder().encode('workflow state'.repeat(50));
 * const compressed = gzip.compress(payload);
 * console.log(compressed instanceof Uint8Array); // true
 * ```
 */
export function createCompressor(algorithm: CompressionAlgorithm): Compressor {
  switch (algorithm) {
    case 'gzip':
      return {
        algorithm: 'gzip',
        compress(data: Uint8Array): Uint8Array {
          return gzipSync(data);
        },
      };

    case 'brotli':
      return {
        algorithm: 'brotli',
        compress(data: Uint8Array): Uint8Array {
          return brotliCompressSync(data);
        },
      };

    case 'none':
      return {
        algorithm: 'none',
        compress(data: Uint8Array): Uint8Array {
          return data;
        },
      };
  }
}

// ---------------------------------------------------------------------------
// Compress / decompress with header framing
// ---------------------------------------------------------------------------

/**
 * Compress a payload, prepending a 2-byte header: magic byte (`0xC1`) +
 * algorithm byte.
 *
 * If the data is below the threshold or the algorithm is `'none'`, the payload
 * is stored with a `[0xC1, 0x00]` header and no compression is applied.
 */
export async function compressPayload(
  data: Uint8Array,
  compressor: Compressor,
  threshold: number,
): Promise<Uint8Array> {
  if (data.length < threshold || compressor.algorithm === 'none') {
    const result = new Uint8Array(data.length + HEADER_SIZE);
    result[0] = MAGIC_BYTE;
    result[1] = ALGORITHM_UNCOMPRESSED;
    result.set(data, HEADER_SIZE);
    return result;
  }

  const compressed = await compressor.compress(data);

  // Fall back to uncompressed framing if compression expanded the data
  // (common with high-entropy payloads like already-compressed images).
  if (compressed.length + HEADER_SIZE >= data.length + HEADER_SIZE) {
    const result = new Uint8Array(data.length + HEADER_SIZE);
    result[0] = MAGIC_BYTE;
    result[1] = ALGORITHM_UNCOMPRESSED;
    result.set(data, HEADER_SIZE);
    return result;
  }

  const algorithmByte = compressor.algorithm === 'gzip' ? ALGORITHM_GZIP : ALGORITHM_BROTLI;

  const result = new Uint8Array(compressed.length + HEADER_SIZE);
  result[0] = MAGIC_BYTE;
  result[1] = algorithmByte;
  result.set(compressed, HEADER_SIZE);
  return result;
}

/**
 * Decompress a payload by reading the 2-byte header (magic + algorithm).
 *
 * - `[0xC1, 0x00]` → uncompressed, return the rest as-is
 * - `[0xC1, 0x01]` → gzip-compressed, decompress
 * - `[0xC1, 0x02]` → brotli-compressed, decompress
 *
 * Empty payloads are valid only when framed as `[0xC1, 0x00]`. Unframed empty
 * input is rejected because it cannot prove which storage format produced it.
 */
export async function decompressPayload(data: Uint8Array): Promise<Uint8Array> {
  if (data.length < HEADER_SIZE) {
    throw new Error('Compression payload missing 2-byte header.');
  }

  if (data[0] !== MAGIC_BYTE) {
    throw new Error('Compression payload missing magic byte 0xC1.');
  }

  const algorithm = data[1]!;
  const body = data.slice(HEADER_SIZE);

  switch (algorithm) {
    case ALGORITHM_UNCOMPRESSED:
      return body;

    case ALGORITHM_GZIP:
      return gunzipSync(body);

    case ALGORITHM_BROTLI:
      return brotliDecompressSync(body);

    default:
      throw new Error(
        `Compression payload uses unsupported algorithm byte 0x${algorithm
          .toString(16)
          .padStart(2, '0')}.`,
      );
  }
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_THRESHOLD = 4096;
const DEFAULT_ALGORITHM: CompressionAlgorithm = 'gzip';

/** Resolve partial compression options into a fully specified configuration. */
export function resolveCompressionOptions(
  options?: CompressionOptions,
): Required<CompressionOptions> {
  return {
    threshold: options?.threshold ?? DEFAULT_THRESHOLD,
    algorithm: options?.algorithm ?? DEFAULT_ALGORITHM,
  };
}
