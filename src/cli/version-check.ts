import { resolve } from 'node:path';

import type { CommandOutput } from './types.ts';

/** Checks stored workflow history against the current workflow definitions. */
export async function executeVersionCheck(options: {
  database: string;
  workflows: string;
  json: boolean;
}): Promise<CommandOutput> {
  if (!options.workflows) {
    return {
      stdout: '',
      stderr: 'Error: --workflows flag is required for version:check',
      exitCode: 1,
    };
  }

  const { runVersionCheck } = await import('../diagnostics/version-check.ts');
  const { formatVersionCheckReport } = await import('../diagnostics/format.ts');
  const { BunSQLiteStorage } = await import('../storage/bun-sql.ts');

  const storage = new BunSQLiteStorage(options.database);

  try {
    const workflowsPath = resolve(process.cwd(), options.workflows);
    const { loadRegistrationsFromModule } = await import('../diagnostics/validate.ts');
    const { registrations } = await loadRegistrationsFromModule(workflowsPath);
    const report = await runVersionCheck(storage, registrations);
    const stdout = options.json
      ? JSON.stringify(report, null, 2)
      : formatVersionCheckReport(report);
    return { stdout, exitCode: 0 };
  } finally {
    storage[Symbol.dispose]();
  }
}
