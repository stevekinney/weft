import { describe, expect, it } from 'bun:test';

import {
  classifyBetterSqlite3Failure,
  createMissingBetterSqlite3Error,
  isBetterSqlite3LoadFailure,
  loadBetterSqlite3ForTest,
} from './node-sqlite-loader.ts';

const MISSING_BETTER_SQLITE_ERROR =
  'NodeSQLiteStorage requires the optional peer dependency "better-sqlite3".';

function errorWithCode(message: string, code: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

describe('isBetterSqlite3LoadFailure', () => {
  it('recognizes a MODULE_NOT_FOUND error naming better-sqlite3', () => {
    expect(
      isBetterSqlite3LoadFailure(
        errorWithCode("Cannot find module 'better-sqlite3'", 'MODULE_NOT_FOUND'),
      ),
    ).toBe(true);
    expect(
      isBetterSqlite3LoadFailure(
        errorWithCode('Cannot find module "better-sqlite3"', 'MODULE_NOT_FOUND'),
      ),
    ).toBe(true);
  });

  it('recognizes a MODULE_NOT_FOUND error naming the native bindings package', () => {
    // better-sqlite3 loads its native binding through the `bindings` package, so a
    // missing `bindings` module is the same root cause as a missing better-sqlite3.
    expect(
      isBetterSqlite3LoadFailure(
        errorWithCode("Cannot find module 'bindings'", 'MODULE_NOT_FOUND'),
      ),
    ).toBe(true);
    expect(
      isBetterSqlite3LoadFailure(
        errorWithCode('Cannot find module "bindings"', 'MODULE_NOT_FOUND'),
      ),
    ).toBe(true);
  });

  it('does not recognize a MODULE_NOT_FOUND error for an unrelated module', () => {
    expect(
      isBetterSqlite3LoadFailure(
        errorWithCode("Cannot find module 'some-other-pkg'", 'MODULE_NOT_FOUND'),
      ),
    ).toBe(false);
  });

  it('recognizes an ERR_DLOPEN_FAILED error naming better-sqlite3', () => {
    expect(
      isBetterSqlite3LoadFailure(
        errorWithCode("'better-sqlite3' is not yet supported in Bun.", 'ERR_DLOPEN_FAILED'),
      ),
    ).toBe(true);
  });

  it('does not recognize an ERR_DLOPEN_FAILED error for an unrelated binding', () => {
    expect(
      isBetterSqlite3LoadFailure(errorWithCode('failed to load other.node', 'ERR_DLOPEN_FAILED')),
    ).toBe(false);
  });

  it('recognizes a bindings lookup failure for the better-sqlite3 native module', () => {
    expect(
      isBetterSqlite3LoadFailure(
        new Error(
          'Could not locate the bindings file. Tried:\n → /app/node_modules/better-sqlite3/build/Release/better_sqlite3.node',
        ),
      ),
    ).toBe(true);
  });

  it('does not recognize an error with an unrelated code', () => {
    expect(isBetterSqlite3LoadFailure(errorWithCode('boom', 'EACCES'))).toBe(false);
  });

  it('does not recognize a non-Error value', () => {
    expect(isBetterSqlite3LoadFailure('not an error')).toBe(false);
    expect(isBetterSqlite3LoadFailure(null)).toBe(false);
  });
});

describe('classifyBetterSqlite3Failure', () => {
  it('separates an absent package from an uncompiled binding', () => {
    // These two were indistinguishable before COR-1278, and the conflation is
    // what made an unbuilt binding read as a missing dependency for three
    // investigations. Their remedies are different, so their diagnoses must be.
    expect(
      classifyBetterSqlite3Failure(
        errorWithCode("Cannot find module 'better-sqlite3'", 'MODULE_NOT_FOUND'),
      ),
    ).toBe('missing-package');
    expect(
      classifyBetterSqlite3Failure(
        new Error(
          'Could not locate the bindings file. Tried:\n → /app/node_modules/better-sqlite3/build/Release/better_sqlite3.node',
        ),
      ),
    ).toBe('unbuilt-binding');
  });

  it('classifies a refused binding as a dlopen failure', () => {
    expect(
      classifyBetterSqlite3Failure(
        errorWithCode("'better-sqlite3' is not yet supported in Bun.", 'ERR_DLOPEN_FAILED'),
      ),
    ).toBe('dlopen-failed');
  });

  it('returns undefined for anything it does not recognize', () => {
    expect(classifyBetterSqlite3Failure(errorWithCode('boom', 'EACCES'))).toBeUndefined();
    expect(classifyBetterSqlite3Failure('not an error')).toBeUndefined();
  });
});

describe('createMissingBetterSqlite3Error', () => {
  it('produces an actionable error that preserves the original cause', () => {
    const cause = errorWithCode("Cannot find module 'better-sqlite3'", 'MODULE_NOT_FOUND');
    const error = createMissingBetterSqlite3Error(cause);
    expect(error.message).toContain(MISSING_BETTER_SQLITE_ERROR);
    expect(error.cause).toBe(cause);
  });

  it('tells an uncompiled binding to rebuild rather than to install', () => {
    const cause = new Error(
      'Could not locate the bindings file. Tried:\n → /app/node_modules/better-sqlite3/build/Release/better_sqlite3.node',
    );
    const error = createMissingBetterSqlite3Error(cause);
    expect(error.message).toContain('its native binding was never compiled');
    expect(error.message).toContain('bun install --force');
    // The wrong advice must be gone, not merely supplemented.
    expect(error.message).not.toContain('bun add better-sqlite3');
  });

  it('appends the underlying message so it survives into a thrown assertion', () => {
    const error = createMissingBetterSqlite3Error(new Error('the real reason'));
    expect(error.message).toContain('Underlying error: the real reason');
  });

  it('describes a non-Error cause rather than dropping it', () => {
    expect(createMissingBetterSqlite3Error('a string cause').message).toContain(
      'Underlying error: a string cause',
    );
  });
});

describe('loadBetterSqlite3ForTest', () => {
  it('returns the constructor when the resolver succeeds', () => {
    class FakeDatabase {
      readonly path = ':memory:';
    }
    const resolved = loadBetterSqlite3ForTest(
      () => FakeDatabase as unknown as ReturnType<typeof loadBetterSqlite3ForTest>,
    );
    expect(resolved).toBe(FakeDatabase as unknown as typeof resolved);
  });

  it('unwraps a module default export', () => {
    class FakeDatabase {
      readonly path = ':memory:';
    }
    const resolved = loadBetterSqlite3ForTest(
      () => ({ default: FakeDatabase }) as unknown as ReturnType<typeof loadBetterSqlite3ForTest>,
    );
    expect(resolved).toBe(FakeDatabase as unknown as typeof resolved);
  });

  it('reshapes a recognized resolver failure into the actionable peer-dependency error', () => {
    expect(() =>
      loadBetterSqlite3ForTest(() => {
        throw errorWithCode("Cannot find module 'better-sqlite3'", 'MODULE_NOT_FOUND');
      }),
    ).toThrow(MISSING_BETTER_SQLITE_ERROR);
  });

  it('rethrows an unrecognized resolver failure unchanged rather than masking it', () => {
    // A permission error (or a syntax/runtime error while evaluating the module) is
    // NOT a missing-dependency failure; reshaping it would hide the real cause. The
    // original error must propagate untouched.
    const permissionError = errorWithCode('EACCES: permission denied', 'EACCES');
    let thrown: unknown;
    try {
      loadBetterSqlite3ForTest(() => {
        throw permissionError;
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBe(permissionError);
    expect((thrown as Error).message).not.toContain('better-sqlite3');
  });
});
