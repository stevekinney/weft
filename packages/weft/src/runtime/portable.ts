/**
 * Runtime-agnostic primitives that all portable code uses instead of calling
 * `Bun.*` directly. Each helper uses a platform-neutral API that Bun, Node,
 * and the browser share (Web APIs first, Node built-ins lazy-loaded through
 * `process.getBuiltinModule` so browser bundles never pull in `node:*`); none
 * of them inspects which runtime is hosting the process.
 *
 * @module runtime/portable
 */

import { readEnvironmentVariable as readConfiguredEnvironmentVariable } from './environment-configuration.ts';

// ---------------------------------------------------------------------------
// Test seam for the Node built-in loader
// ---------------------------------------------------------------------------

type PortableRuntimeTestOverrides = {
  process?: typeof globalThis.process | undefined;
};

let portableRuntimeTestOverrides: PortableRuntimeTestOverrides | undefined;

/**
 * Replace the `process` global that {@link tryLoadNodeBuiltin} reads, so a test
 * can simulate a runtime with no `process.getBuiltinModule` (a browser or edge
 * isolate). Pass `undefined` to restore the real global.
 * @internal
 */
export function setPortableRuntimeTestOverridesForTesting(
  overrides?: PortableRuntimeTestOverrides,
): void {
  portableRuntimeTestOverrides = overrides;
}

function getProcess(): typeof globalThis.process | undefined {
  if (portableRuntimeTestOverrides && 'process' in portableRuntimeTestOverrides) {
    return portableRuntimeTestOverrides.process;
  }
  return globalThis.process;
}

// ---------------------------------------------------------------------------
// Environment variables
// ---------------------------------------------------------------------------

/**
 * Read an environment variable without assuming a runtime.
 *
 * Reads `process.env`, which Bun and Node both provide, and returns
 * `undefined` anywhere else (browsers, edge runtimes) — where the global does
 * not exist and a bare `process.env[...]` reference would throw a
 * `ReferenceError`.
 * @internal
 */
export function readEnvironmentVariable(name: string): string | undefined {
  return readConfiguredEnvironmentVariable(name);
}

// ---------------------------------------------------------------------------
// sleep
// ---------------------------------------------------------------------------

/**
 * Pause execution for the given number of milliseconds by wrapping `setTimeout`
 * in a `Promise`.
 *
 * With a `signal`, the pause ends early (resolving, not rejecting) when the
 * signal aborts, and its timer is cleared, so a loop that sleeps between polls
 * leaves no pending timer behind once its owner shuts down. A signal that is
 * already aborted resolves immediately. The caller checks the signal after the
 * pause to decide whether to continue.
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
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted === true) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal?.addEventListener('abort', finish, { once: true });
  });
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

/**
 * Load a Node.js built-in module without a static `node:*` import.
 *
 * This package is ESM (`"type": "module"` in package.json), so `require`
 * is not defined in Node runtime. `process.getBuiltinModule` (Node 22.5+,
 * also implemented by Bun) is the correct way to load Node built-ins from
 * ESM code without needing `createRequire` — and, crucially, without a
 * static `import ... from 'node:*'` specifier that a browser bundler would
 * try to resolve or stub. Returns `undefined` in the browser or any runtime
 * lacking `process.getBuiltinModule`, so callers on a browser-reachable path
 * must treat the result as optional rather than throwing at import time.
 *
 * Overloaded per known specifier so callers get the correct module type from
 * the literal `id` argument alone, without an explicit type argument. Add a
 * new literal overload here when a new built-in specifier is loaded through
 * this helper.
 * @internal
 */
export function tryLoadNodeBuiltin(id: 'bun:sqlite'): typeof import('bun:sqlite') | undefined;
export function tryLoadNodeBuiltin(id: 'node:crypto'): typeof import('node:crypto') | undefined;
export function tryLoadNodeBuiltin(id: 'node:dns'): typeof import('node:dns') | undefined;
export function tryLoadNodeBuiltin(id: 'node:fs'): typeof import('node:fs') | undefined;
export function tryLoadNodeBuiltin(
  id: 'node:fs/promises',
): typeof import('node:fs/promises') | undefined;
export function tryLoadNodeBuiltin(id: 'node:zlib'): typeof import('node:zlib') | undefined;
export function tryLoadNodeBuiltin(id: 'node:module'): typeof import('node:module') | undefined;
export function tryLoadNodeBuiltin(id: string): unknown {
  const nodeProcess = getProcess();
  if (typeof nodeProcess?.getBuiltinModule !== 'function') {
    return undefined;
  }
  return nodeProcess.getBuiltinModule(id);
}

// ---------------------------------------------------------------------------
// File size
// ---------------------------------------------------------------------------

/**
 * Return the byte size of a file at the given path, read with `node:fs`
 * `statSync` (loaded via `process.getBuiltinModule`, which Bun and Node 22.5+
 * both provide).
 *
 * Missing files return `0` (important for WAL probing in the diagnostics
 * module).
 *
 * Not available in browser/edge runtimes — throws if called there.
 */
export function fileSize(path: string): number {
  const fs = tryLoadNodeBuiltin('node:fs');
  if (!fs) {
    throw new Error(
      'fileSize() requires Bun or Node 22.5+ (process.getBuiltinModule). ' +
        'Not available in browser or edge runtimes.',
    );
  }

  try {
    return fs.statSync(path).size;
  } catch (error) {
    // A missing file is a size of zero, not an error.
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
      return 0;
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Compression
// ---------------------------------------------------------------------------

/**
 * Load `node:zlib` if available for Node-side callers (used by compression.ts
 * for brotli). Returns `undefined` in browsers so they can degrade cleanly.
 * @internal
 */
export function tryLoadNodeZlib(): typeof import('node:zlib') | undefined {
  return tryLoadNodeBuiltin('node:zlib');
}
