import { describe, expect, it } from 'bun:test';

import packageJson from '../../package.json';

describe('storage package exports', () => {
  it('does not expose the retired Bun SQLite subpath', () => {
    expect(Object.hasOwn(packageJson.exports, './storage/bun-sqlite')).toBe(false);
  });

  it('exposes a unified SQLite type surface with runtime-specific implementations', () => {
    const sqliteExport = packageJson.exports['./storage/sqlite'];

    expect(sqliteExport).toMatchObject({
      types: './dist/storage/sqlite.d.ts',
      bun: './dist/storage/bun-sql.js',
      node: './dist/storage/node-sqlite.js',
      import: './dist/storage/node-sqlite.js',
      default: './dist/storage/node-sqlite.js',
    });
  });

  it('keeps explicit SQLite runtime override subpaths runtime-specific', () => {
    expect(packageJson.exports['./storage/sqlite/bun']).toEqual({
      types: './dist/storage/bun-sql.d.ts',
      bun: './dist/storage/bun-sql.js',
    });
    expect(packageJson.exports['./storage/sqlite/node']).toEqual({
      types: './dist/storage/node-sqlite.d.ts',
      node: './dist/storage/node-sqlite.js',
    });
  });

  it('exposes WebExtension, HTTP, and resolve storage subpaths', () => {
    expect(Object.hasOwn(packageJson.exports, './storage/web-extension')).toBe(true);
    expect(Object.hasOwn(packageJson.exports, './storage/http')).toBe(true);
    expect(Object.hasOwn(packageJson.exports, './storage/resolve')).toBe(true);
  });

  it('exposes storage conformance helpers through storage/testing only', () => {
    expect(packageJson.exports['./storage/testing']).toEqual({
      types: './dist/storage/testing.d.ts',
      bun: './dist/storage/testing.js',
    });
    expect(packageJson.exports['./testing']).toEqual({
      types: './dist/testing/index.d.ts',
      bun: './dist/testing/index.js',
      import: './dist/testing/index.js',
      default: './dist/testing/index.js',
    });
  });

  it('exposes the text-value-store string key/value facade as a subpath', () => {
    expect(packageJson.exports['./storage/text-value-store']).toEqual({
      types: './dist/storage/text-value-store.d.ts',
      bun: './dist/storage/text-value-store.js',
      import: './dist/storage/text-value-store.js',
      default: './dist/storage/text-value-store.js',
    });
  });

  it('exposes the text key-value import helper as a subpath', () => {
    expect(packageJson.exports['./storage/text-value-import']).toEqual({
      types: './dist/storage/text-value-import.d.ts',
      bun: './dist/storage/text-value-import.js',
      import: './dist/storage/text-value-import.js',
      default: './dist/storage/text-value-import.js',
    });
  });

  it('exposes compressed storage as a runtime-specific subpath', () => {
    expect(packageJson.exports['./storage/compressed']).toEqual({
      types: './dist/storage/compressed-storage.d.ts',
      bun: './dist/storage/compressed-storage.js',
      import: './dist/storage/compressed-storage.js',
      default: './dist/storage/compressed-storage.js',
    });
  });

  it('exposes the RemoteWorker protocol contract as a package subpath', () => {
    expect(packageJson.exports['./worker-protocol']).toEqual({
      types: './dist/worker/protocol.d.ts',
      bun: './dist/worker/protocol.js',
      import: './dist/worker/protocol.js',
      default: './dist/worker/protocol.js',
    });
  });
});
