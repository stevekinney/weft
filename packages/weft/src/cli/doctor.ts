import type { CommandOutput } from './types.ts';

/** Runs diagnostics against a SQLite database and formats the report. */
export async function executeDoctor(options: {
  database: string;
  json: boolean;
}): Promise<CommandOutput> {
  const { collectDiagnostics } = await import('../index.ts');
  const { formatDiagnosticReport } = await import('../index.ts');
  const { BunSQLiteStorage } = await import('../index.ts');

  const storage = new BunSQLiteStorage(options.database);

  try {
    const report = await collectDiagnostics(storage, options.database);
    const stdout = options.json ? JSON.stringify(report, null, 2) : formatDiagnosticReport(report);
    return { stdout, exitCode: 0 };
  } finally {
    storage[Symbol.dispose]();
  }
}
