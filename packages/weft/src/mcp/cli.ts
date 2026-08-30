#!/usr/bin/env bun

import { createStorage } from '../cli/storage-factory.ts';
import { Engine } from '../core/engine.ts';
import { runMcpStdioSession, type McpStdioAdmission } from './stdio.ts';

const HELP_TEXT = `weft-mcp - Run a local Weft MCP stdio server

Usage: weft-mcp [options]

Options:
  --storage <memory|sqlite>       Storage backend (default: memory)
  --database <path>               SQLite database path (default: ./weft.db)
  --startup-token <token>         Require the first frame to authenticate with this token
  --allow-unauthenticated-local-admin
                                  Grant local stdio clients full engine access
  --help                          Show this help text
`;

type Arguments = {
  storage: 'memory' | 'sqlite';
  database: string;
  admission: McpStdioAdmission;
  help: boolean;
};

const parsed = parseArguments(Bun.argv.slice(2));
if (parsed.help) {
  console.log(HELP_TEXT);
  process.exit(0);
}

const storage = await createStorage(parsed.storage, parsed.database);
const engine = new Engine({ storage });
const sessionResult = await runMcpStdioSession({
  input: Bun.stdin.stream(),
  output: new WritableStream<Uint8Array>({
    async write(chunk) {
      await Bun.write(Bun.stdout, chunk);
    },
  }),
  engine,
  admission: parsed.admission,
});
storage[Symbol.dispose]();
process.exit(sessionResult.exitCode);

function parseArguments(args: string[]): Arguments {
  const result: Arguments = {
    storage: 'memory',
    database: './weft.db',
    admission: { kind: 'require-one' },
    help: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    switch (arg) {
      case '--help':
      case '-h':
        result.help = true;
        break;
      case '--storage':
        result.storage = parseStorage(args[++index]);
        break;
      case '--database':
        result.database = args[++index] ?? result.database;
        break;
      case '--startup-token':
        result.admission = { kind: 'startup-token', token: requireNonEmptyValue(args[++index]) };
        break;
      case '--allow-unauthenticated-local-admin':
        result.admission = { kind: 'allow-unauthenticated-local-admin' };
        break;
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }

  return result;
}

function parseStorage(value: string | undefined): 'memory' | 'sqlite' {
  if (value === 'memory' || value === 'sqlite') return value;
  throw new Error('--storage must be "memory" or "sqlite"');
}

function requireNonEmptyValue(value: string | undefined): string {
  if (value !== undefined && value.trim().length > 0) return value;
  throw new Error('--startup-token requires a non-empty value');
}
