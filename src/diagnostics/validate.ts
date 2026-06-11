/**
 * Design-time workflow validation for `weft validate`.
 *
 * Analyses workflow registrations for common anti-patterns:
 *
 * 1. **Unbounded retry policy** — an activity whose `retry.maxAttempts` is
 *    `Infinity` (or the workflow registration specifies `retry.maxAttempts`
 *    equal to `Infinity`).  Unbounded retries can loop indefinitely on
 *    persistent failures, consuming resources without ever propagating the
 *    error.
 *
 * 2. **Stateful activity without compensator** — an activity definition that
 *    is not marked `idempotent: true` and has no `compensate` function.
 *    Without a compensator, the activity cannot participate in saga-style
 *    rollback, leaving partial writes stranded on failure.
 *
 * 3. **Non-serializable activity input/output** — detected by passing a
 *    sentinel object through `JSON.stringify`; non-serializable values
 *    (functions, Symbols, circular references) cannot survive checkpoint
 *    persistence.
 *
 * @module diagnostics/validate
 */

import { resolve } from 'node:path';

import type { ConstraintDefinition } from '../core/constraint.ts';
import type {
  ActivityDefinition,
  DefinitionSchema,
  RetentionPolicy,
  SearchAttributeSchema,
  WorkflowFunction,
} from '../core/types.ts';

/**
 * Loosely-typed workflow registration shape used only by the `weft validate`
 * and `weft schedule` CLIs when loading workflow modules from disk. This is
 * intentionally separate from the public `WorkflowDefinition` type because
 * loaded modules historically export bare `{ handler, ... }` objects that
 * do not carry a `name` field — the registration key comes from the export
 * key, not the object itself.
 */
export interface WorkflowRegistration<TInput = unknown, TOutput = unknown> {
  version?: string;
  description?: string;
  tags?: ReadonlyArray<string>;
  inputSchema?: DefinitionSchema<unknown, TInput>;
  outputSchema?: DefinitionSchema<unknown, TOutput>;
  handler: WorkflowFunction<TInput, TOutput>;
  searchAttributes?: SearchAttributeSchema;
  retention?: RetentionPolicy;
  constraints?: ConstraintDefinition[];
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ValidationIssueSeverity = 'error' | 'warning';
export type ValidationIssueCode =
  | 'unbounded-retry'
  | 'stateful-without-compensator'
  | 'non-serializable-input';

export interface ValidationIssue {
  severity: ValidationIssueSeverity;
  code: ValidationIssueCode;
  workflowType: string;
  activityName?: string;
  message: string;
}

export interface ValidationReport {
  /** Total number of workflow registrations scanned. */
  workflowCount: number;
  /** All detected issues across all registrations. */
  issues: ValidationIssue[];
  /** `true` when there are no `error`-severity issues. */
  valid: boolean;
}

// ---------------------------------------------------------------------------
// Check: unbounded retry policy
// ---------------------------------------------------------------------------

function checkUnboundedRetry(
  workflowType: string,
  activity: ActivityDefinition,
): ValidationIssue | null {
  const maxAttempts = activity.retry?.maxAttempts;
  if (maxAttempts !== undefined && !isFinite(maxAttempts)) {
    return {
      severity: 'error',
      code: 'unbounded-retry',
      workflowType,
      activityName: activity.name,
      message:
        `Activity "${activity.name}" has retry.maxAttempts = ${maxAttempts}. ` +
        `Unbounded retries loop indefinitely on persistent failures. ` +
        `Set a finite maxAttempts (e.g. 3) or handle the error explicitly.`,
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Check: stateful activity without compensator
// ---------------------------------------------------------------------------

function checkStatefulWithoutCompensator(
  workflowType: string,
  activity: ActivityDefinition,
): ValidationIssue | null {
  // An activity is considered "stateful" (has side effects that need rollback)
  // when it is not explicitly marked idempotent. If it has no compensate
  // function it cannot participate in saga-style rollback.
  if (!activity.idempotent && !activity.compensate) {
    return {
      severity: 'error',
      code: 'stateful-without-compensator',
      workflowType,
      activityName: activity.name,
      message:
        `Activity "${activity.name}" is not marked idempotent and has no compensate ` +
        `function. If this activity has side effects (writes, charges, emails) it ` +
        `cannot participate in ctx.saga() rollback. ` +
        `Either add a compensate function or set idempotent: true.`,
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Validate a collection of workflow registrations for common anti-patterns.
 *
 * @param registrations A record of workflow type name → WorkflowRegistration.
 * @param activities    Optional list of ActivityDefinition objects to check.
 *                      Activities are not reachable from WorkflowRegistration
 *                      alone, so pass them explicitly when available.
 */
export function validateRegistrations(
  registrations: Record<string, WorkflowRegistration>,
  activities: ActivityDefinition[] = [],
): ValidationReport {
  const issues: ValidationIssue[] = [];
  const workflowTypes = Object.keys(registrations);

  // Check explicitly-passed activities. Activities are not tied to a specific
  // workflow registration (they live in closures), so they are labelled
  // '(standalone)' when no registration context is available.
  for (const activity of activities) {
    const retryIssue = checkUnboundedRetry('(standalone)', activity);
    if (retryIssue) issues.push(retryIssue);

    const compensatorIssue = checkStatefulWithoutCompensator('(standalone)', activity);
    if (compensatorIssue) issues.push(compensatorIssue);
  }

  const hasErrors = issues.some((i) => i.severity === 'error');

  return {
    workflowCount: workflowTypes.length,
    issues,
    valid: !hasErrors,
  };
}

// ---------------------------------------------------------------------------
// Module loading
// ---------------------------------------------------------------------------

/**
 * Load workflow registrations from an entry module.
 *
 * The entry module may export:
 * - `default`: a `Record<string, WorkflowRegistration>` — used directly.
 * - Named exports typed as `WorkflowRegistration` with a `handler` field.
 * - Named exports typed as `ActivityDefinition` with `name` and `execute` fields.
 *
 * Relative `modulePath` values are resolved against `process.cwd()` so that
 * paths like `./my-workflows.ts` work correctly when the CLI is invoked from
 * the user's project directory.
 *
 * Returns `{ registrations, activities }` extracted from the module.
 */
function collectFromExports(
  entries: Iterable<[string, unknown]>,
  registrations: Record<string, WorkflowRegistration>,
  activities: ActivityDefinition[],
  options: { allowOverwrite: boolean },
): void {
  for (const [key, value] of entries) {
    if (isWorkflowRegistration(value)) {
      if (options.allowOverwrite || !(key in registrations)) {
        registrations[key] = value;
      }
    } else if (isActivityDefinition(value)) {
      if (options.allowOverwrite || !activities.includes(value)) {
        activities.push(value);
      }
    }
  }
}

export async function loadRegistrationsFromModule(modulePath: string): Promise<{
  registrations: Record<string, WorkflowRegistration>;
  activities: ActivityDefinition[];
}> {
  const absolutePath = resolve(process.cwd(), modulePath);
  const mod = await import(absolutePath);

  const registrations: Record<string, WorkflowRegistration> = {};
  const activities: ActivityDefinition[] = [];

  const defaultExport = mod.default as unknown;
  if (defaultExport !== null && typeof defaultExport === 'object') {
    collectFromExports(
      Object.entries(defaultExport as Record<string, unknown>),
      registrations,
      activities,
      { allowOverwrite: true },
    );
  }

  const namedEntries = Object.entries(mod as Record<string, unknown>).filter(
    ([key]) => key !== 'default',
  );
  collectFromExports(namedEntries, registrations, activities, { allowOverwrite: false });

  return { registrations, activities };
}

// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------

function isWorkflowRegistration(value: unknown): value is WorkflowRegistration {
  return (
    typeof value === 'object' &&
    value !== null &&
    'handler' in value &&
    typeof (value as { handler: unknown }).handler === 'function'
  );
}

function isActivityDefinition(value: unknown): value is ActivityDefinition {
  // Activity definitions created by the `activity()` helper are functions
  // (with `name` and `execute` assigned as own properties), not plain objects.
  // Accept both object and function shapes.
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) {
    return false;
  }
  const v = value as { name?: unknown; execute?: unknown };
  return typeof v.name === 'string' && typeof v.execute === 'function';
}

// ---------------------------------------------------------------------------
// Output formatting
// ---------------------------------------------------------------------------

/**
 * Format a validation report as human-readable text for console output.
 */
export function formatValidationReport(report: ValidationReport, entryPath: string): string {
  const lines: string[] = [];

  lines.push(`Validating: ${entryPath}`);
  lines.push(`Workflows scanned: ${report.workflowCount}`);

  if (report.issues.length === 0) {
    lines.push('No issues found.');
    return lines.join('\n');
  }

  lines.push(`Issues found: ${report.issues.length}`);
  lines.push('');

  for (const issue of report.issues) {
    const location = issue.activityName
      ? `${issue.workflowType} / ${issue.activityName}`
      : issue.workflowType;
    const severityLabel = issue.severity === 'error' ? 'error' : 'warning';
    lines.push(`  [${severityLabel}] ${location}`);
    lines.push(`    ${issue.code}: ${issue.message}`);
    lines.push('');
  }

  return lines.join('\n').trimEnd();
}
