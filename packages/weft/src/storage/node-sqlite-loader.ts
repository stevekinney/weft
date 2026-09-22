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

import { tryLoadNodeBuiltin } from '../runtime/portable.ts';

/**
 * Minimal `better-sqlite3` `Database` surface this adapter uses. Defined here so
 * both the loader and the storage module compile without the package installed.
 */
export type BetterSqliteStatement = {
  run(...parameters: unknown[]): unknown;
  get(...parameters: unknown[]): Record<string, unknown> | undefined;
  all(...parameters: unknown[]): Record<string, unknown>[];
};

export type BetterSqliteTransaction = (...args: unknown[]) => unknown;

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
 * Which way a `better-sqlite3` load failed. The three have different remedies,
 * so they are distinguished rather than collapsed.
 *
 * - `missing-package`: the module is not installed at all.
 * - `unbuilt-binding`: the module is installed but `better_sqlite3.node` was
 *   never compiled, because the package's `install` script did not run.
 * - `dlopen-failed`: the compiled binding exists but the runtime refused it.
 */
export type BetterSqlite3FailureKind = 'missing-package' | 'unbuilt-binding' | 'dlopen-failed';

/**
 * Classify a `better-sqlite3` load failure, or `undefined` when `error` is not
 * one and should be rethrown untouched.
 *
 * The `errorCode === undefined` branch is the one that matters most and reads
 * like an accident: `bindings` throws a plain `Error` with no `code` when it
 * cannot find the compiled addon. That is the signature of an install whose
 * lifecycle scripts were suppressed — `bun install --ignore-scripts` leaves the
 * package on disk, fully requirable, with no `build/` directory. Collapsing it
 * into "the dependency is missing" sent three separate investigations looking
 * for an absent module that was in fact present (COR-1278).
 */
/** Whether `message` names `module` the way a resolver error quotes it. */
function namesModule(message: string, module: string): boolean {
  return message.includes(`'${module}'`) || message.includes(`"${module}"`);
}

/** A `MODULE_NOT_FOUND` for the package itself or for the `bindings` loader it goes through. */
function classifyModuleNotFound(message: string): BetterSqlite3FailureKind | undefined {
  const relevant = namesModule(message, 'better-sqlite3') || namesModule(message, 'bindings');
  return relevant ? 'missing-package' : undefined;
}

/** A `bindings` lookup that found no compiled addon: the install script never ran. */
function classifyUncodedFailure(message: string): BetterSqlite3FailureKind | undefined {
  const locatesBinding =
    message.startsWith('Could not locate the bindings file.') &&
    message.includes('better_sqlite3.node');
  return locatesBinding ? 'unbuilt-binding' : undefined;
}

export function classifyBetterSqlite3Failure(error: unknown): BetterSqlite3FailureKind | undefined {
  if (!(error instanceof Error)) return undefined;

  const { message } = error;
  switch ((error as Error & { code?: unknown }).code) {
    case 'MODULE_NOT_FOUND':
      return classifyModuleNotFound(message);
    case 'ERR_DLOPEN_FAILED':
      return message.includes('better-sqlite3') ? 'dlopen-failed' : undefined;
    case undefined:
      return classifyUncodedFailure(message);
    default:
      return undefined;
  }
}

/** What to tell the caller for each way the load can fail. */
const failureGuidance: Record<BetterSqlite3FailureKind, string> = {
  'missing-package':
    'NodeSQLiteStorage requires the optional peer dependency "better-sqlite3". ' +
    'Install it in your application with: bun add better-sqlite3 (or npm install better-sqlite3).',
  'unbuilt-binding':
    'NodeSQLiteStorage found "better-sqlite3" installed, but its native binding was never ' +
    "compiled: the package's install script did not run. Reinstall with lifecycle scripts " +
    'enabled — bun install --force (an ordinary bun install will NOT rebuild an already-linked ' +
    'package), or npm rebuild better-sqlite3.',
  'dlopen-failed':
    'NodeSQLiteStorage could not load the "better-sqlite3" native binding in this runtime. ' +
    'The compiled addon is present but was refused; it must be run under Node.js, and built ' +
    'for this platform and ABI.',
};

/**
 * Build the actionable error thrown when `better-sqlite3` cannot be loaded.
 *
 * The underlying message is appended rather than swallowed. It was previously
 * carried only on `cause`, where nothing printed it: a test asserting on the
 * thrown message showed the same sentence for an absent package and an unbuilt
 * binding, which is the whole reason COR-1278 took four rounds to diagnose.
 */
export function createMissingBetterSqlite3Error(cause: unknown): Error {
  const kind = classifyBetterSqlite3Failure(cause);
  const guidance = kind ? failureGuidance[kind] : failureGuidance['missing-package'];
  const underlying = cause instanceof Error ? cause.message : String(cause);
  return new Error(`${guidance}\nUnderlying error: ${underlying}`, { cause });
}

/**
 * Whether `error` is a recognizable `better-sqlite3` load failure (missing
 * package, unbuilt native binding, or dlopen failure) worth reshaping into the
 * actionable error rather than re-throwing raw.
 */
export function isBetterSqlite3LoadFailure(error: unknown): boolean {
  return classifyBetterSqlite3Failure(error) !== undefined;
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
  const module = tryLoadNodeBuiltin('node:module');
  if (module === undefined) throw new Error('NodeSQLiteStorage requires Bun or Node.js.');
  const requireFromHere = module.createRequire(import.meta.url);
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
