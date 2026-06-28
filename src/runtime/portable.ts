/**
 * Runtime-agnostic primitives that all portable code uses instead of calling
 * `Bun.*` directly. When running under Bun the fast native paths are used;
 * otherwise standard Web APIs are preferred, with Node built-ins as a last
 * resort (lazy-imported so browser bundles never pull in `node:*`).
 *
 * @module runtime/portable
 */

// ---------------------------------------------------------------------------
// Runtime detection
// ---------------------------------------------------------------------------

/** Identifies the JavaScript runtime hosting this process. */
export type RuntimeKind = 'bun' | 'node' | 'browser' | 'edge';

type PortableRuntimeTestOverrides = {
  bun?: typeof globalThis.Bun | undefined;
  process?: typeof globalThis.process | undefined;
  window?: typeof globalThis.window | undefined;
  document?: typeof globalThis.document | undefined;
};

let portableRuntimeTestOverrides: PortableRuntimeTestOverrides | undefined;

export function setPortableRuntimeTestOverridesForTesting(
  overrides?: PortableRuntimeTestOverrides,
): void {
  portableRuntimeTestOverrides = overrides;
}

function isBunRuntime(): boolean {
  const bun =
    portableRuntimeTestOverrides && 'bun' in portableRuntimeTestOverrides
      ? portableRuntimeTestOverrides.bun
      : globalThis.Bun;
  return typeof bun !== 'undefined';
}

function getProcess(): typeof globalThis.process | undefined {
  if (portableRuntimeTestOverrides && 'process' in portableRuntimeTestOverrides) {
    return portableRuntimeTestOverrides.process;
  }
  return globalThis.process;
}

function isNodeRuntime(): boolean {
  return typeof getProcess()?.versions?.node === 'string';
}

function isBrowserRuntime(): boolean {
  const windowValue =
    portableRuntimeTestOverrides && 'window' in portableRuntimeTestOverrides
      ? portableRuntimeTestOverrides.window
      : globalThis.window;
  const documentValue =
    portableRuntimeTestOverrides && 'document' in portableRuntimeTestOverrides
      ? portableRuntimeTestOverrides.document
      : globalThis.document;
  return typeof windowValue !== 'undefined' || typeof documentValue !== 'undefined';
}

type RuntimeDetector = { readonly kind: RuntimeKind; readonly matches: () => boolean };

// Precedence: bun → node → browser → edge. A Bun process running through Node
// compatibility still reports 'bun' because `isBunRuntime` runs first.
const RUNTIME_DETECTORS: readonly RuntimeDetector[] = [
  { kind: 'bun', matches: isBunRuntime },
  { kind: 'node', matches: isNodeRuntime },
  { kind: 'browser', matches: isBrowserRuntime },
];

/**
 * Detect the current JavaScript runtime.
 * Detection precedence is bun → node → browser → edge: a Bun process running
 * through Node compatibility still reports 'bun'; the function never falls through if
 * `globalThis.Bun` is defined.
 *
 * @example
 * ```ts
 * import { detectRuntime } from '@lostgradient/weft';
 *
 * const runtime = detectRuntime();
 * // Returns 'bun' | 'node' | 'browser' | 'edge'
 * console.log(runtime); // e.g. 'bun' when running under Bun
 * ```
 */
export function detectRuntime(): RuntimeKind {
  for (const detector of RUNTIME_DETECTORS) {
    if (detector.matches()) return detector.kind;
  }
  return 'edge';
}

// ---------------------------------------------------------------------------
// sleep
// ---------------------------------------------------------------------------

/**
 * Pause execution for the given number of milliseconds.
 *
 * Uses `Bun.sleep` when available (microtask-friendly), otherwise wraps
 * `setTimeout` in a `Promise`.
 *
 * @example
 * ```ts
 * import { sleep } from '@lostgradient/weft';
 *
 * async function poll() {
 *   for (let i = 0; i < 3; i++) {
 *     await sleep(100);
 *     console.log('tick', i);
 *   }
 * }
 * await poll();
 * ```
 */
export function sleep(ms: number): Promise<void> {
  if (isBunRuntime()) return Bun.sleep(ms);

  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Hashing — non-cryptographic, cache-key-quality
// ---------------------------------------------------------------------------

/**
 * FNV-1a 64-bit hash returning a 16-character hex string.
 *
 * Implemented with `BigInt` for correctness with the true 64-bit FNV
 * offset basis (`0xcbf29ce484222325`) and prime (`0x00000100000001b3`).
 * BigInt is slow relative to `Math.imul`, but correctness matters more
 * than microseconds here — these hashes are cache keys, not hot-path
 * operations, and the 64-bit output must be deterministic across
 * runtimes because it is persisted to durable storage (event-log chain
 * hashes, tool-effect dedup keys, prompt-cache keys).
 */
const FNV_OFFSET_BASIS_64 = 0xcbf29ce484222325n;
const FNV_PRIME_64 = 0x00000100000001b3n;
const MASK_64 = 0xffffffffffffffffn;

function fnv1a64(data: Uint8Array): string {
  let hash = FNV_OFFSET_BASIS_64;
  for (let i = 0; i < data.length; i++) {
    hash ^= BigInt(data[i]!);
    hash = (hash * FNV_PRIME_64) & MASK_64;
  }
  return hash.toString(16).padStart(16, '0');
}

const textEncoder = new TextEncoder();

/**
 * Hash a byte buffer to a 16-character hex string.
 *
 * Uses FNV-1a unconditionally across all runtimes for stable output.
 * Hashes may be persisted to durable storage (event-log chains, tool-effect
 * dedup), so runtime-specific algorithms would break cross-runtime reads.
 *
 * @example
 * ```ts
 * import { hashBytes } from '@lostgradient/weft';
 *
 * const data = new TextEncoder().encode('hello');
 * const hash = hashBytes(data);
 * console.log(hash.length);  // 16
 * console.log(hashBytes(data) === hash); // true (deterministic)
 * ```
 */
export function hashBytes(data: Uint8Array): string {
  return fnv1a64(data);
}

/**
 * Hash a string to a 16-character hex string.
 *
 * Uses FNV-1a unconditionally across all runtimes for stable output.
 *
 * @example
 * ```ts
 * import { hashString } from '@lostgradient/weft';
 *
 * const h1 = hashString('workflow-key');
 * const h2 = hashString('workflow-key');
 * console.log(h1 === h2);   // true (stable across calls)
 * console.log(h1.length);   // 16
 * ```
 */
export function hashString(data: string): string {
  return fnv1a64(textEncoder.encode(data));
}

// ---------------------------------------------------------------------------
// Node built-in module loader — ESM-safe via process.getBuiltinModule
// ---------------------------------------------------------------------------

type ProcessWithBuiltinModule = NodeJS.Process & {
  getBuiltinModule?: (id: string) => unknown;
};

/**
 * Load a Node.js built-in module without using `require()`.
 *
 * This package is ESM (`"type": "module"` in package.json), so `require`
 * is not defined in Node runtime. `process.getBuiltinModule` (Node 22.5+)
 * is the correct way to load Node built-ins from ESM code without needing
 * `createRequire`. Returns `undefined` in non-Node runtimes.
 */
function loadNodeBuiltin<T>(id: string): T | undefined {
  const nodeProcess = getProcess() as ProcessWithBuiltinModule | undefined;
  const getBuiltinModule = nodeProcess?.getBuiltinModule;
  if (typeof getBuiltinModule !== 'function') {
    return undefined;
  }
  return getBuiltinModule(id) as T;
}

// ---------------------------------------------------------------------------
// File size
// ---------------------------------------------------------------------------

/**
 * Return the byte size of a file at the given path.
 *
 * - Bun: `Bun.file(path).size`
 * - Node 22.5+: `node:fs` `statSync` loaded via `process.getBuiltinModule`
 * - Missing files return `0` to match Bun's behavior (important for WAL
 *   probing in the diagnostics module).
 *
 * Not available in browser/edge runtimes — throws if called there.
 */
export function fileSize(path: string): number {
  if (isBunRuntime()) {
    return Bun.file(path).size;
  }

  const fs = loadNodeBuiltin<typeof import('node:fs')>('node:fs');
  if (!fs) {
    throw new Error(
      'fileSize() requires Bun or Node 22.5+ (process.getBuiltinModule). ' +
        'Not available in browser or edge runtimes.',
    );
  }

  try {
    return fs.statSync(path).size;
  } catch (error) {
    // Match Bun.file().size behavior: return 0 for missing files.
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as { code: unknown }).code === 'ENOENT'
    ) {
      return 0;
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Compression — synchronous gzip
// ---------------------------------------------------------------------------

function loadNodeZlib(): typeof import('node:zlib') {
  const zlib = loadNodeBuiltin<typeof import('node:zlib')>('node:zlib');
  if (!zlib) {
    throw new Error(
      'gzip/gunzip require Bun or Node 22.5+ (process.getBuiltinModule). ' +
        'Not available in browser or edge runtimes — use CompressionStream directly.',
    );
  }
  return zlib;
}

/**
 * Gzip-compress a byte buffer synchronously.
 *
 * - Bun: `Bun.gzipSync`
 * - Node 22.5+: `node:zlib` via `process.getBuiltinModule`
 */
export function gzipSync(data: Uint8Array): Uint8Array {
  if (isBunRuntime()) {
    return new Uint8Array(Bun.gzipSync(new Uint8Array(data)));
  }
  return new Uint8Array(loadNodeZlib().gzipSync(data));
}

/**
 * Gunzip-decompress a byte buffer synchronously.
 *
 * - Bun: `Bun.gunzipSync`
 * - Node 22.5+: `node:zlib` via `process.getBuiltinModule`
 */
export function gunzipSync(data: Uint8Array): Uint8Array {
  if (isBunRuntime()) {
    return new Uint8Array(Bun.gunzipSync(new Uint8Array(data)));
  }
  return new Uint8Array(loadNodeZlib().gunzipSync(data));
}

/**
 * Load `node:zlib` if available for Node-side callers (used by compression.ts
 * for brotli). Returns `undefined` in browsers so they can degrade cleanly.
 * @internal
 */
export function tryLoadNodeZlib(): typeof import('node:zlib') | undefined {
  return loadNodeBuiltin<typeof import('node:zlib')>('node:zlib');
}
