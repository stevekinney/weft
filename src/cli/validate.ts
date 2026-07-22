import type { ActivityDefinition, WorkflowDefinition } from '../core/types.ts';
import type { ValidationReport } from '../diagnostics/validate.ts';
import type { CommandOutput } from './types.ts';
import { expandGlobEntryPaths } from './utilities.ts';

type LoadRegistrationsFromModule = (modulePath: string) => Promise<{
  registrations: Record<string, WorkflowDefinition>;
  activities: ActivityDefinition[];
}>;

type ValidateRegistrations = (
  registrations: Record<string, WorkflowDefinition>,
  activities: ActivityDefinition[],
) => ValidationReport;

type ValidationReportEntry = {
  entryPath: string;
  report: ReturnType<ValidateRegistrations>;
};

type ValidationLoadErrorEntry = {
  entryPath: string;
  loadError: string;
};

type ValidationEntry = ValidationReportEntry | ValidationLoadErrorEntry;

type ValidationSummary = {
  entries: ValidationEntry[];
  hasLoadErrors: boolean;
  hasValidationErrors: boolean;
};

async function expandValidateEntryPaths(entryPaths: string[]): Promise<string[]> {
  return expandGlobEntryPaths(entryPaths);
}

async function processValidateEntry(
  entryPath: string,
  loadRegistrationsFromModule: LoadRegistrationsFromModule,
  validateRegistrations: ValidateRegistrations,
): Promise<ValidationEntry> {
  try {
    const loaded = await loadRegistrationsFromModule(entryPath);
    const report = validateRegistrations(loaded.registrations, loaded.activities);
    return { entryPath, report };
  } catch (error) {
    return {
      entryPath,
      loadError: error instanceof Error ? error.message : String(error),
    };
  }
}

async function collectValidationEntries(
  entryPaths: string[],
  loadRegistrationsFromModule: LoadRegistrationsFromModule,
  validateRegistrations: ValidateRegistrations,
): Promise<ValidationSummary> {
  const entries: ValidationEntry[] = [];
  let hasLoadErrors = false;
  let hasValidationErrors = false;

  for (const entryPath of entryPaths) {
    const entry = await processValidateEntry(
      entryPath,
      loadRegistrationsFromModule,
      validateRegistrations,
    );
    entries.push(entry);

    if ('loadError' in entry) {
      hasLoadErrors = true;
    } else if (!entry.report.valid) {
      hasValidationErrors = true;
    }
  }

  return { entries, hasLoadErrors, hasValidationErrors };
}

function formatValidationJson(summary: ValidationSummary): string {
  const entries = summary.entries.map((entry) => {
    if ('loadError' in entry) {
      return {
        entryPath: entry.entryPath,
        loadError: entry.loadError,
      };
    }

    return {
      entryPath: entry.entryPath,
      ...entry.report,
    };
  });

  return JSON.stringify(
    {
      entries,
      valid: !summary.hasLoadErrors && !summary.hasValidationErrors,
      hasLoadErrors: summary.hasLoadErrors,
      hasValidationErrors: summary.hasValidationErrors,
    },
    null,
    2,
  );
}

function formatValidationLoadError(entry: ValidationLoadErrorEntry): string {
  return `Error: could not load entry file '${entry.entryPath}': ${entry.loadError}`;
}

/** Validates workflow definition modules and reports load or design-time errors. */
export async function executeValidate(options: {
  entryPaths: string[];
  json: boolean;
}): Promise<CommandOutput> {
  if (options.entryPaths.length === 0) {
    return {
      stdout: '',
      stderr: 'Error: entry file path is required for validate',
      exitCode: 2,
    };
  }

  const expandedEntryPaths = await expandValidateEntryPaths(options.entryPaths);
  const { loadRegistrationsFromModule, validateRegistrations, formatValidationReport } =
    await import('../diagnostics/validate.ts');
  const summary = await collectValidationEntries(
    expandedEntryPaths,
    loadRegistrationsFromModule,
    validateRegistrations,
  );
  const exitCode = summary.hasLoadErrors ? 2 : summary.hasValidationErrors ? 1 : 0;

  if (options.json) {
    return { stdout: formatValidationJson(summary), exitCode };
  }

  const stdout = summary.entries
    .filter((entry): entry is ValidationReportEntry => 'report' in entry)
    .map((entry) => formatValidationReport(entry.report, entry.entryPath))
    .join('\n\n');
  const stderr = summary.entries
    .filter((entry): entry is ValidationLoadErrorEntry => 'loadError' in entry)
    .map(formatValidationLoadError)
    .join('\n');

  return {
    stdout,
    ...(stderr ? { stderr } : {}),
    exitCode,
  };
}
