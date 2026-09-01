/**
 * Lazy loader for the optional `better-sqlite3` peer dependency used by
 * {@link NodeSQLiteStorage}. Kept in its own module — and deliberately NOT in the
 * package `exports` map — so the test-only injection seam
 * ({@link loadBetterSqlite3ForTest}) never becomes part of the documented public
 * surface. `node-sqlite.ts` imports `loadBetterSqlite3` (production path);
 * `node-sqlite.test.ts` imports the test entry directly from here.
 *
 * @module storage/node-sqlite-loader
 */

import { createRequire } from 'node:module';

/**
 * Minimal `better-sqlite3` `Database` surface this adapter uses. Defined here so
 * both the loader and the storage module compile without the package installed.
 */
export type BetterSqliteStatement = {
  run(...parameters: unknown[]): unknown;
  get(...parameters: unknown[]): Record<string, unknown> | undefined;
  all(...parameters: unknown[]): Record<string, unknown>[];
};

export type BetterSqliteTransaction = <TArguments extends unknown[], TResult>(
  ...args: TArguments
) => TResult;

export type BetterSqliteDatabase = {
  pragma(source: string): unknown;
  exec(source: string): void;
  prepare(source: string): BetterSqliteStatement;
  transaction<TArguments extends unknown[], TResult>(
    fn: (...args: TArguments) => TResult,
  ): BetterSqliteTransaction;
  close(): void;
};

export type BetterSqliteConstructor = new (path: string) => BetterSqliteDatabase;

/** Lazily resolved `better-sqlite3` constructor, cached after first load. */
let DatabaseConstructor: BetterSqliteConstructor | undefined;

/**
 * Build the actionable error thrown when `better-sqlite3` cannot be loaded —
 * either because the optional dependency is absent or its native binding fails
 * to dlopen.
 */
export function createMissingBetterSqlite3Error(cause: unknown): Error {
  return new Error(
    'NodeSQLiteStorage requires the optional peer dependency "better-sqlite3". ' +
      'Install it in your application with: bun add better-sqlite3 (or npm install better-sqlite3).',
    { cause },
  );
}

/**
 * Whether `error` is a recognizable `better-sqlite3` load failure (missing
 * package or native-binding dlopen failure) worth reshaping into the actionable
 * peer-dependency error rather than re-throwing raw.
 */
export function isBetterSqlite3LoadFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;

  const errorCode = (error as Error & { code?: unknown }).code;

  if (errorCode === 'MODULE_NOT_FOUND') {
    return (
      error.message.includes("'better-sqlite3'") ||
      error.message.includes('"better-sqlite3"') ||
      error.message.includes("'bindings'") ||
      error.message.includes('"bindings"')
    );
  }

  if (errorCode === 'ERR_DLOPEN_FAILED') {
    return error.message.includes('better-sqlite3');
  }

  if (errorCode === undefined) {
    return (
      error.message.startsWith('Could not locate the bindings file.') &&
      error.message.includes('better_sqlite3.node')
    );
  }

  return false;
}

/**
 * Resolve the `better-sqlite3` module via a CommonJS require. This package is
 * ESM (`type: module`), so the global `require` is not defined — `createRequire`
 * from `node:module` builds a CommonJS require for loading the native binding.
 *
 * Extracted as a standalone function so tests can inject a throwing resolver
 * (see {@link loadBetterSqlite3ForTest}) to exercise the missing/failed-dependency
 * paths WITHOUT `mock.module('node:module', ...)`. That mock is irreversible in
 * Bun: it patches the CJS loader process-wide and `mock.restore()` does not undo
 * it, which poisons `require()` for every later test in the same process
 * (notably any WASM module that requires a core module during boot).
 */
function resolveBetterSqlite3Module(): {
  default?: BetterSqliteConstructor;
} & BetterSqliteConstructor {
  const requireFromHere = createRequire(import.meta.url);
  return requireFromHere('better-sqlite3') as {
    default?: BetterSqliteConstructor;
  } & BetterSqliteConstructor;
}

/** Resolver for the `better-sqlite3` module. Injectable for tests. */
type BetterSqlite3ModuleResolver = typeof resolveBetterSqlite3Module;

/**
 * Load (and cache) the `better-sqlite3` constructor. Reshapes a recognized load
 * failure into the actionable peer-dependency error.
 */
export function loadBetterSqlite3(
  resolveModule: BetterSqlite3ModuleResolver = resolveBetterSqlite3Module,
): BetterSqliteConstructor {
  if (DatabaseConstructor) return DatabaseConstructor;

  let mod: { default?: BetterSqliteConstructor } & BetterSqliteConstructor;
  try {
    mod = resolveModule();
  } catch (error) {
    // Only a recognized load failure (package absent or native dlopen failure)
    // is reshaped into the actionable peer-dependency message. An unrecognized
    // error — a permission failure, or a syntax/runtime error while evaluating
    // the module — is rethrown unchanged so its real cause is not masked.
    if (isBetterSqlite3LoadFailure(error)) {
      throw createMissingBetterSqlite3Error(error);
    }
    throw error;
  }

  DatabaseConstructor = typeof mod.default === 'function' ? mod.default : mod;
  return DatabaseConstructor;
}

/**
 * Test-only entry that exercises {@link loadBetterSqlite3}'s module-resolution
 * and error-shaping with an injected resolver, bypassing the cached constructor
 * so the missing/failed-dependency paths run every call. This lets those paths be
 * tested without mocking the global `node:module` loader. Lives in this
 * non-exported module so it never reaches the public package surface.
 */
export function loadBetterSqlite3ForTest(
  resolveModule: BetterSqlite3ModuleResolver,
): BetterSqliteConstructor {
  const previous = DatabaseConstructor;
  DatabaseConstructor = undefined;
  try {
    return loadBetterSqlite3(resolveModule);
  } finally {
    DatabaseConstructor = previous;
  }
}
