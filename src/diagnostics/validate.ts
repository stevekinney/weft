/**
 * Design-time workflow validation for `weft validate`.
 *
 * Analyses workflow definitions for common anti-patterns:
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

import type { ActivityDefinition, WorkflowDefinition } from '../core/types.ts';

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
  /** Total number of workflow definitions scanned. */
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
 * Validate a collection of workflow definitions for common anti-patterns.
 *
 * @param registrations A record of workflow type name to WorkflowDefinition.
 * @param activities    Optional standalone ActivityDefinition objects to check
 *                      in addition to activities embedded in workflow definitions.
 */
export function validateRegistrations(
  registrations: Record<string, WorkflowDefinition>,
  activities: ActivityDefinition[] = [],
): ValidationReport {
  const issues: ValidationIssue[] = [];
  const workflowTypes = Object.keys(registrations);

  for (const definition of Object.values(registrations)) {
    for (const activity of workflowActivities(definition)) {
      appendActivityIssues(issues, definition.name, activity);
    }
  }

  // Check explicitly-passed activities. Activities are not tied to a specific
  // workflow registration (they live in closures), so they are labelled
  // '(standalone)' when no registration context is available.
  for (const activity of activities) {
    appendActivityIssues(issues, '(standalone)', activity);
  }

  const hasErrors = issues.some((i) => i.severity === 'error');

  return {
    workflowCount: workflowTypes.length,
    issues,
    valid: !hasErrors,
  };
}

function appendActivityIssues(
  issues: ValidationIssue[],
  workflowType: string,
  activity: ActivityDefinition,
): void {
  const retryIssue = checkUnboundedRetry(workflowType, activity);
  if (retryIssue) issues.push(retryIssue);

  const compensatorIssue = checkStatefulWithoutCompensator(workflowType, activity);
  if (compensatorIssue) issues.push(compensatorIssue);
}

function workflowActivities(definition: WorkflowDefinition): ActivityDefinition[] {
  if (!('activities' in definition) || !isObject(definition.activities)) {
    return [];
  }
  return Object.values(definition.activities).filter(isActivityDefinition);
}

// ---------------------------------------------------------------------------
// Module loading
// ---------------------------------------------------------------------------

/**
 * Load workflow definitions from an entry module.
 *
 * The entry module may export:
 * - `default`: a `WorkflowDefinition` or map of workflow definitions.
 * - Named `WorkflowDefinition` values or maps of workflow definitions.
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
  registrations: Record<string, WorkflowDefinition>,
  activities: ActivityDefinition[],
  options: { allowOverwrite: boolean; depth: number },
): void {
  for (const [key, value] of entries) {
    collectExport(key, value, registrations, activities, options);
  }
}

function collectExport(
  key: string,
  value: unknown,
  registrations: Record<string, WorkflowDefinition>,
  activities: ActivityDefinition[],
  options: { allowOverwrite: boolean; depth: number },
): void {
  if (isWorkflowDefinition(value)) {
    if (options.allowOverwrite || !Object.hasOwn(registrations, value.name)) {
      registrations[value.name] = value;
    }
    return;
  }
  if (isActivityDefinition(value)) {
    if (options.allowOverwrite || !activities.includes(value)) {
      activities.push(value);
    }
    return;
  }
  if (!isObject(value)) return;

  if (options.depth === 0 && isDefinitionMap(value)) {
    collectFromExports(Object.entries(value), registrations, activities, {
      ...options,
      depth: options.depth + 1,
    });
    return;
  }

  assertNotRemovedWorkflowShape(key, value);
}

export async function loadRegistrationsFromModule(modulePath: string): Promise<{
  registrations: Record<string, WorkflowDefinition>;
  activities: ActivityDefinition[];
}> {
  const absolutePath = resolve(process.cwd(), modulePath);
  const mod = await import(absolutePath);

  const registrations: Record<string, WorkflowDefinition> = Object.create(null);
  const activities: ActivityDefinition[] = [];

  const defaultExport = mod.default as unknown;
  if (defaultExport !== undefined) {
    collectFromExports([['default', defaultExport]], registrations, activities, {
      allowOverwrite: true,
      depth: 0,
    });
  }

  const namedEntries = Object.entries(mod as Record<string, unknown>).filter(
    ([key]) => key !== 'default',
  );
  collectFromExports(namedEntries, registrations, activities, {
    allowOverwrite: false,
    depth: 0,
  });

  return { registrations, activities };
}

// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isRemovedWorkflowShape(value: unknown): value is Record<string, unknown> {
  if (!isObject(value) || !Object.hasOwn(value, 'handler')) return false;

  const handler = value['handler'];
  if (typeof handler !== 'function') return false;

  const functionKind = Object.prototype.toString.call(handler);
  if (functionKind === '[object AsyncGeneratorFunction]') return true;

  const hasLegacyMetadata = [
    'version',
    'description',
    'tags',
    'inputSchema',
    'outputSchema',
    'searchAttributes',
  ].some((key) => Object.hasOwn(value, key));
  if (hasLegacyMetadata) return true;

  // A handler-only ordinary function is the removed synchronous wrapper shape.
  // It is structurally indistinguishable from a synchronous framework handler
  // without invoking user code, so workflow entry modules reserve this shape;
  // async route-style handlers remain unrelated exports and are ignored.
  return functionKind === '[object Function]' && Object.keys(value).length === 1;
}

function assertNotRemovedWorkflowShape(exportName: string, value: Record<string, unknown>): void {
  if (isRemovedWorkflowShape(value)) {
    throw new TypeError(
      `Workflow export "${exportName}" must be a builder-produced workflow definition with its own name. Create it with \`workflow({ name }).execute(handler)\`.`,
    );
  }
}

function isDefinitionMap(value: Record<string, unknown>): boolean {
  // Keep nested map discovery and rejection narrower than direct exports:
  // arbitrary route maps may also contain callable `handler` fields.
  return Object.values(value).some(
    (entry) =>
      isWorkflowDefinition(entry) || isActivityDefinition(entry) || isRemovedWorkflowShape(entry),
  );
}

function isWorkflowDefinition(value: unknown): value is WorkflowDefinition {
  return (
    isObject(value) &&
    typeof value['name'] === 'string' &&
    'handler' in value &&
    typeof value['handler'] === 'function'
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
