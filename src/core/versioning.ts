/**
 * Workflow version comparison and checkpoint diagnostics.
 *
 * Provides utilities for detecting version mismatches between stored
 * and registered workflow definitions.
 *
 * @module versioning
 */

import { WeftError } from './weft-error.ts';
import type { WorkflowVersionDiff } from './workflow-version-tuple.ts';
import { formatWorkflowVersionDiff } from './workflow-version-tuple.ts';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default version string assigned when no version is specified. */
export const DEFAULT_WORKFLOW_VERSION = '0.0.0';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type VersionCompatibility = 'compatible' | 'incompatible';

// ---------------------------------------------------------------------------
// Version comparison
// ---------------------------------------------------------------------------

/**
 * Compare a stored workflow version with the currently registered version.
 *
 * - `"compatible"` — versions match; no action needed.
 * - `"incompatible"` — versions differ; the engine will throw a
 *   {@link VersionMismatchError} instead of resuming silently.
 *
 * @example
 * ```ts
 * import { checkVersionCompatibility } from '@lostgradient/weft';
 *
 * console.log(checkVersionCompatibility('1.0.0', '1.0.0')); // 'compatible'
 * console.log(checkVersionCompatibility('1.0.0', '2.0.0')); // 'incompatible'
 * ```
 */
export function checkVersionCompatibility(
  storedVersion: string,
  registeredVersion: string,
): VersionCompatibility {
  if (storedVersion === registeredVersion) {
    return 'compatible';
  }

  return 'incompatible';
}

// ---------------------------------------------------------------------------
// Checkpoint shape diffing
// ---------------------------------------------------------------------------

/** Description of a single field-level difference between checkpoint shapes. */
export type FieldDiff =
  | { field: string; change: 'added'; newType: string }
  | { field: string; change: 'removed'; oldType: string }
  | { field: string; change: 'type-changed'; oldType: string; newType: string };

/** Shape descriptor: maps field names to their type names (e.g., `"string"`, `"object"`). */
export type ShapeDescriptor = Record<string, string>;

/**
 * Compare two checkpoint shape descriptors and return the field-level diffs.
 *
 * Returns an empty array when the shapes are identical.
 *
 * @example
 * ```ts
 * import { diffCheckpointShapes } from '@lostgradient/weft';
 *
 * const diffs = diffCheckpointShapes(
 *   { userId: 'string', count: 'number' },
 *   { userId: 'string', count: 'number', newField: 'boolean' },
 * );
 * console.log(diffs.length);        // 1
 * console.log(diffs[0]?.change);    // 'added'
 * console.log(diffs[0]?.field);     // 'newField'
 * ```
 */
export function diffCheckpointShapes(
  oldShape: ShapeDescriptor,
  newShape: ShapeDescriptor,
): FieldDiff[] {
  const diffs: FieldDiff[] = [];
  const allKeys = new Set([...Object.keys(oldShape), ...Object.keys(newShape)]);

  for (const key of allKeys) {
    const inOld = Object.hasOwn(oldShape, key);
    const inNew = Object.hasOwn(newShape, key);

    if (inOld && !inNew) {
      diffs.push({ field: key, change: 'removed', oldType: oldShape[key]! });
    } else if (!inOld && inNew) {
      diffs.push({ field: key, change: 'added', newType: newShape[key]! });
    } else if (inOld && inNew && oldShape[key] !== newShape[key]) {
      diffs.push({
        field: key,
        change: 'type-changed',
        oldType: oldShape[key]!,
        newType: newShape[key]!,
      });
    }
  }

  return diffs;
}

/**
 * Infer a shape descriptor from an arbitrary value by walking its top-level keys
 * and recording the `typeof` of each value.
 *
 * @example
 * ```ts
 * import { inferShape } from '@lostgradient/weft';
 *
 * const shape = inferShape({ userId: 'abc', count: 42, active: true });
 * console.log(shape['userId']); // 'string'
 * console.log(shape['count']);  // 'number'
 * console.log(shape['active']); // 'boolean'
 * ```
 */
export function inferShape(value: unknown): ShapeDescriptor {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  const shape: ShapeDescriptor = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    shape[key] = val === null ? 'null' : Array.isArray(val) ? 'array' : typeof val;
  }
  return shape;
}

/** Format field diffs into a human-readable summary. */
function formatFieldDiffs(diffs: FieldDiff[]): string {
  if (diffs.length === 0) return '';

  const lines = diffs.map((diff) => {
    switch (diff.change) {
      case 'added':
        return `  - field \`${diff.field}\` was added (type: ${diff.newType})`;
      case 'removed':
        return `  - field \`${diff.field}\` was removed (was: ${diff.oldType})`;
      case 'type-changed':
        return `  - field \`${diff.field}\` changed type: ${diff.oldType} → ${diff.newType}`;
    }
  });

  return `\nCheckpoint shape changes:\n${lines.join('\n')}`;
}

function hasWorkflowVersionDiff(versionDiff: WorkflowVersionDiff | undefined): boolean {
  return (
    versionDiff !== undefined &&
    (versionDiff.workflowVersion !== undefined ||
      versionDiff.agentVersion !== undefined ||
      (versionDiff.toolVersions?.length ?? 0) > 0)
  );
}

function createVersionMismatchMessage(parameters: {
  workflowId: string;
  workflowType: string;
  storedVersion: string;
  registeredVersion: string;
  fieldDiffs: FieldDiff[] | undefined;
  versionDiff: WorkflowVersionDiff | undefined;
}): string {
  const { workflowId, workflowType, storedVersion, registeredVersion, fieldDiffs, versionDiff } =
    parameters;
  const hasPersistedStateDrift =
    storedVersion === registeredVersion &&
    ((fieldDiffs?.length ?? 0) > 0 || hasWorkflowVersionDiff(versionDiff));
  const baseMessage = hasPersistedStateDrift
    ? `Version mismatch for workflow "${workflowType}" (${workflowId}): ` +
      `stored version ${storedVersion} matches registered version ${registeredVersion}, ` +
      `but the persisted state is incompatible with the registered definition`
    : `Version mismatch for workflow "${workflowType}" (${workflowId}): ` +
      `stored version ${storedVersion} does not match registered version ${registeredVersion}`;

  return (
    baseMessage +
    (fieldDiffs && fieldDiffs.length > 0 ? formatFieldDiffs(fieldDiffs) : '') +
    (versionDiff ? formatWorkflowVersionDiff(versionDiff) : '')
  );
}

// ---------------------------------------------------------------------------
// Error
// ---------------------------------------------------------------------------

/** Options for providing shape information to VersionMismatchError. */
export type ShapeDiffOptions = {
  oldShape: ShapeDescriptor;
  newShape: ShapeDescriptor;
};

/**
 * Thrown when a workflow's stored version does not match its registered
 * version.
 *
 * When shape information is provided, the error message includes a
 * field-level diff describing exactly which fields changed.
 *
 * When version tuple information is provided, the error message includes a
 * summary of which workflow, agent, or tool versions changed.
 *
 * @example
 * ```ts
 * import { VersionMismatchError } from '@lostgradient/weft';
 *
 * try {
 *   throw new VersionMismatchError(
 *     'wf-123',
 *     'orderWorkflow',
 *     '1.0.0',
 *     '2.0.0',
 *   );
 * } catch (err) {
 *   if (err instanceof VersionMismatchError) {
 *     console.log(err.storedVersion);     // '1.0.0'
 *     console.log(err.registeredVersion); // '2.0.0'
 *   }
 * }
 * ```
 */
export class VersionMismatchError extends WeftError<'VersionMismatchError'> {
  readonly workflowId: string;
  readonly storedVersion: string;
  readonly registeredVersion: string;
  readonly workflowType: string;
  readonly fieldDiffs: FieldDiff[] | undefined;
  readonly versionDiff: WorkflowVersionDiff | undefined;

  constructor(
    workflowId: string,
    workflowType: string,
    storedVersion: string,
    registeredVersion: string,
    shapeDiff?: ShapeDiffOptions,
    versionDiff?: WorkflowVersionDiff,
  ) {
    const diffs = shapeDiff
      ? diffCheckpointShapes(shapeDiff.oldShape, shapeDiff.newShape)
      : undefined;

    super(
      'VersionMismatchError',
      createVersionMismatchMessage({
        workflowId,
        workflowType,
        storedVersion,
        registeredVersion,
        fieldDiffs: diffs,
        versionDiff,
      }),
    );
    this.workflowId = workflowId;
    this.workflowType = workflowType;
    this.storedVersion = storedVersion;
    this.registeredVersion = registeredVersion;
    this.fieldDiffs = diffs;
    this.versionDiff = versionDiff;
  }
}
