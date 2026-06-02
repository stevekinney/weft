#!/usr/bin/env bun

import { Database } from 'bun:sqlite';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { exit } from 'node:process';
import { parseArgs } from 'node:util';

import { BunSQLiteStorage } from '../src/storage/bun-sql.ts';
import {
  copyTextKeyValueRowsToStorage,
  type TextKeyValueRow,
} from '../src/storage/text-value-import.ts';

type CliArgs = {
  sourcePath: string;
  targetPath: string;
  targetPrefix: string;
  sourceTable: string;
};

function printUsage(): void {
  console.error(
    [
      'import-string-kv-sqlite-to-weft',
      '',
      'Usage:',
      '  bun scripts/import-string-kv-sqlite-to-weft.ts --source <path> --target <path> --target-prefix app:my-service',
      '',
      'Options:',
      '  --source <path>           Required. Existing SQLite database with a string kv table.',
      '  --target <path>           Required. Weft SQLite database to write.',
      '  --target-prefix <prefix>  Required. Application namespace for imported keys.',
      '  --source-table <name>     Source table name (default: kv).',
      '  --help                    Show this usage.',
    ].join('\n'),
  );
}

function parseCliArgs(): CliArgs {
  const { values } = parseArgs({
    options: {
      source: { type: 'string' },
      target: { type: 'string' },
      'target-prefix': { type: 'string' },
      'source-table': { type: 'string', default: 'kv' },
      help: { type: 'boolean', default: false },
    },
    allowPositionals: false,
  });

  if (values.help) {
    printUsage();
    exit(0);
  }

  if (!values.source || !values.target || !values['target-prefix']) {
    printUsage();
    exit(1);
  }

  return {
    sourcePath: values.source,
    targetPath: values.target,
    targetPrefix: values['target-prefix'],
    sourceTable: values['source-table'] ?? 'kv',
  };
}

function assertSourceTableName(tableName: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(tableName)) {
    throw new Error('Source table name must be a SQLite identifier.');
  }
}

function assertDifferentPaths(sourcePath: string, targetPath: string): void {
  const sourceIdentity = resolvePathIdentity(sourcePath);
  const targetIdentity = resolvePathIdentity(targetPath);

  if (
    sourceIdentity.realPath === targetIdentity.realPath ||
    (sourceIdentity.device !== undefined &&
      sourceIdentity.inode !== undefined &&
      sourceIdentity.device === targetIdentity.device &&
      sourceIdentity.inode === targetIdentity.inode)
  ) {
    throw new Error('Source and target SQLite paths must be different.');
  }
}

type PathIdentity = {
  realPath: string;
  device?: number;
  inode?: number;
};

function resolvePathIdentity(path: string): PathIdentity {
  const absolutePath = resolve(path);
  if (existsSync(absolutePath)) {
    const realPath = realpathSync(absolutePath);
    const stats = statSync(realPath);
    return { realPath, device: stats.dev, inode: stats.ino };
  }

  try {
    return { realPath: resolve(realpathSync(dirname(absolutePath)), basename(absolutePath)) };
  } catch {
    return { realPath: absolutePath };
  }
}

function normalizeTargetPrefix(prefix: string): string {
  return prefix.replaceAll(/:+$/g, '');
}

function assertTargetPrefix(prefix: string): void {
  if (normalizeTargetPrefix(prefix).length === 0) {
    throw new Error('Target prefix must not be empty.');
  }
}

function assertSourceTableExists(database: Database, tableName: string): void {
  const row = database
    .prepare<
      { name: string },
      [string]
    >("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(tableName);

  if (!row) {
    throw new Error(`Source SQLite database does not contain table "${tableName}".`);
  }
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier}"`;
}

function readSourceRows(database: Database, tableName: string): TextKeyValueRow[] {
  const rows = database
    .prepare<
      Record<string, unknown>,
      []
    >(`SELECT key, value FROM ${quoteIdentifier(tableName)} ORDER BY key ASC`)
    .all();

  return rows.map((row) => {
    if (typeof row['key'] !== 'string' || typeof row['value'] !== 'string') {
      throw new Error(
        `Source table "${tableName}" must expose string key and value columns named "key" and "value".`,
      );
    }

    return {
      key: row['key'],
      value: row['value'],
    };
  });
}

async function main(): Promise<void> {
  const args = parseCliArgs();
  assertSourceTableName(args.sourceTable);
  assertDifferentPaths(args.sourcePath, args.targetPath);
  assertTargetPrefix(args.targetPrefix);

  const source = new Database(args.sourcePath, { readonly: true });
  try {
    const target = new BunSQLiteStorage(args.targetPath);
    try {
      assertSourceTableExists(source, args.sourceTable);
      const rows = readSourceRows(source, args.sourceTable);
      const result = await copyTextKeyValueRowsToStorage({
        storage: target,
        rows,
        targetPrefix: args.targetPrefix,
      });
      console.log(`Copied ${result.copied} text key-value rows into ${args.targetPath}.`);
    } finally {
      target[Symbol.dispose]();
    }
  } finally {
    source.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  exit(1);
});
