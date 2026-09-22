import { describe, expect, it } from 'bun:test';

import * as bunSql from './bun-sql.ts';
import * as nodeSqlite from './node-sqlite.ts';

/**
 * The published `./storage/sqlite` subpath is the one entry point in this package whose `types`
 * condition and runtime conditions resolve to *different* modules: types come from
 * `storage/sqlite.ts`, which is declaration-only, while `bun` resolves to `bun-sql.ts` and
 * `node` to `node-sqlite.ts`. A `declare`d symbol has no runtime existence, so the alias exports
 * asserted here are the only thing that makes the subpath importable.
 *
 * Corvidae's consolidation dropped both aliases and a typecheck could not see it: the
 * declaration file satisfies every consumer's compiler, and the subpath then throws
 * `Export named 'SQLiteStorage' not found` on import. It was found by weft's own
 * `examples/order-processing` smoke test running against a mirror-staged tree, which is a long
 * way downstream of where it was introduced.
 */
describe('the ./storage/sqlite runtime aliases', () => {
  it('exposes SQLiteStorage from the Bun module, aliased to BunSQLiteStorage', () => {
    expect(bunSql.SQLiteStorage).toBe(bunSql.BunSQLiteStorage);
  });

  it('exposes SQLiteStorage from the Node module, aliased to NodeSQLiteStorage', () => {
    expect(nodeSqlite.SQLiteStorage).toBe(nodeSqlite.NodeSQLiteStorage);
  });

  /**
   * Asserted as a runtime property rather than a type one on purpose. `import type` would be
   * erased and the test would pass against the exact tree that shipped the defect.
   */
  it('exposes both aliases as runtime values, not type-only re-exports', () => {
    expect(typeof bunSql.SQLiteStorage).toBe('function');
    expect(typeof nodeSqlite.SQLiteStorage).toBe('function');
  });
});
