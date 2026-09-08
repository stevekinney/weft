/**
 * The validation pipeline that turns a resolved-but-untrusted module value
 * into an installable {@link WorkflowRevisionManifest}, or a bounded,
 * structured rejection. Engine-agnostic and pure(-ish): no `Engine`
 * instance, no storage, no catalog access — every check here operates only
 * on the descriptor and the loaded module value, so it can be unit-tested
 * (`validate.test.ts`) without constructing an engine.
 *
 * @module core/source/validate
 */

import { isRecord } from '../../worker/manifest/is-record.ts';
import type { ActivityRegistry } from '../activity-registry.ts';
import {
  DEFAULT_WORKFLOW_COMPATIBILITY_POLICY,
  checkWorkflowCompatibility,
} from '../contract/compatibility.ts';
import type { WorkflowRevisionManifest } from '../contract/types.ts';
import { copyWorkflowDefinition } from '../engine/construction.ts';
import type { RegistrationEntry } from '../engine/engine-internal-types.ts';
import {
  buildPerWorkflowActivityRegistry,
  buildRegistrationEntry,
  isBuilderWorkflowDefinition,
} from '../engine/registration.ts';
import { buildWorkflowManifestFromDefinition } from '../registry-workflow-manifest.ts';
import type { WorkflowDefinition } from '../types.ts';
import { validateWorkflowOrActivityName } from '../types/name-grammar.ts';
import type { RegisteredWorkflowDefinition } from '../types/workflow-registry.ts';
import type { WorkflowSourceRejectionReason } from './errors.ts';
import type { WorkflowSourceDescriptor } from './types.ts';

/**
 * The outcome of {@link validateResolvedWorkflowSource}: either every check
 * passed and this is an installable revision, or validation failed with the
 * complete, ordered list of every applicable
 * {@link WorkflowSourceRejectionReason} — never just the first one found.
 *
 * @example
 * ```ts
 * import type { WorkflowSourceValidationOutcome } from './validate.ts';
 *
 * const outcome: WorkflowSourceValidationOutcome = { ok: false, reasons: ['missing-export'] };
 * console.log(outcome.ok);
 * ```
 */
export type WorkflowSourceValidationOutcome =
  | Readonly<{
      ok: true;
      manifest: WorkflowRevisionManifest;
      definition: RegisteredWorkflowDefinition;
      activityRegistry: ActivityRegistry;
      loadedDefinition: WorkflowDefinition;
    }>
  | Readonly<{ ok: false; reasons: readonly WorkflowSourceRejectionReason[] }>;

/**
 * Read `moduleValue[exportName]` without ever touching the prototype chain —
 * `Object.hasOwn` rather than bracket access alone, so a hostile module
 * value cannot use `exportName: '__proto__'` (or another inherited
 * accessor name) to smuggle back `Object.prototype` instead of a genuine
 * own export. Returns `undefined` for both "no such key" and "key present
 * with value `undefined`", which `validateResolvedWorkflowSource` treats
 * identically (`missing-export`).
 */
function readOwnExport(
  moduleValue: Readonly<Record<string, unknown>>,
  exportName: string,
): unknown {
  return Object.hasOwn(moduleValue, exportName) ? moduleValue[exportName] : undefined;
}

/**
 * Build the synthetic "expected" manifest `checkWorkflowCompatibility`
 * compares `actual` against: `name`/`revision` always overridden to the
 * descriptor's values (the whole point — an actual revision that
 * legitimately differs from what the descriptor expected must be reported
 * as `artifact-revision-mismatch`, never silently accepted), and
 * `workflowVersion`/`contractHash` overridden ONLY when the descriptor pins
 * them, otherwise copied from `actual` so an unpinned field can never
 * produce a false-positive mismatch.
 *
 * Exported (not just used internally by {@link validateResolvedWorkflowSource})
 * so `core/engine/source-resolution.ts`'s catalog fast path can run the
 * identical pin check against an already-cached manifest — a registered
 * handle that pins `workflowVersion`/`contractHash` must reject a cached
 * manifest that contradicts those pins exactly as a fresh load-and-validate
 * would, never silently returning mismatched cached data.
 */
export function buildExpectedManifest(
  descriptor: WorkflowSourceDescriptor,
  actual: WorkflowRevisionManifest,
): WorkflowRevisionManifest {
  return {
    ...actual,
    name: descriptor.name,
    revision: descriptor.revision,
    ...(descriptor.workflowVersion === undefined
      ? {}
      : { workflowVersion: descriptor.workflowVersion }),
    ...(descriptor.contractHash === undefined ? {} : { contractHash: descriptor.contractHash }),
  };
}

/**
 * Validate a resolved-but-untrusted `moduleValue` (the raw value a
 * {@link import('./resolvers.ts').resolveSourceModule} call produced)
 * against `descriptor`'s expectations, in order:
 *
 * 1. `moduleValue` must be a plain record and must own `descriptor.exportName` — else `missing-export`.
 * 2. The export must not itself be an ES module namespace object (an `export * as x` barrel) — else `ambiguous-export`.
 * 3. The export must be a builder-produced `WorkflowDefinition` — else `invalid-definition` (covers the removed bare-handler shape).
 * 4. The export's `name` must pass the wire-safe name grammar — else `invalid-definition`.
 * 5. The export's activities/signals/updates/queries must normalize without error — else `invalid-definition`.
 * 6. A `WorkflowRevisionManifest` must build from the normalized definition without exceeding a WFT-5 hostile-input limit — else `manifest-build-failed`.
 * 7. The built manifest must be compatible with the descriptor's expectations via `checkWorkflowCompatibility` — else the returned `WorkflowCompatibilityReason`s.
 *
 * Every applicable reason at whichever step first fails is returned;
 * later steps never run once an earlier step already failed, since each
 * step's output feeds the next (there is nothing left to check once, say,
 * the export cannot even be found).
 *
 * @example
 * ```ts
 * import type { WorkflowSourceDescriptor } from '@lostgradient/weft';
 *
 * const descriptor: WorkflowSourceDescriptor = {
 *   kind: 'module',
 *   name: 'checkout',
 *   location: './checkout.ts',
 *   exportName: 'checkout',
 *   revision: 'r1',
 * };
 * console.log(descriptor.exportName);
 * ```
 */
export async function validateResolvedWorkflowSource(
  descriptor: WorkflowSourceDescriptor,
  moduleValue: unknown,
): Promise<WorkflowSourceValidationOutcome> {
  if (!isRecord(moduleValue)) {
    return { ok: false, reasons: ['missing-export'] };
  }

  const exportValue = readOwnExport(moduleValue, descriptor.exportName);
  if (exportValue === undefined) {
    return { ok: false, reasons: ['missing-export'] };
  }

  if (Object.prototype.toString.call(exportValue) === '[object Module]') {
    return { ok: false, reasons: ['ambiguous-export'] };
  }

  if (!isBuilderWorkflowDefinition(exportValue)) {
    return { ok: false, reasons: ['invalid-definition'] };
  }
  const loadedDefinition: WorkflowDefinition = exportValue;

  let entry: RegistrationEntry;
  let activityRegistry: ActivityRegistry;
  try {
    validateWorkflowOrActivityName(loadedDefinition.name, 'workflow');
    entry = buildRegistrationEntry(loadedDefinition.name, loadedDefinition);
    activityRegistry = buildPerWorkflowActivityRegistry(exportValue.activities);
  } catch {
    return { ok: false, reasons: ['invalid-definition'] };
  }

  const registeredDefinition = copyWorkflowDefinition(loadedDefinition.name, entry);

  let actualManifest: WorkflowRevisionManifest;
  try {
    actualManifest = await buildWorkflowManifestFromDefinition(
      registeredDefinition,
      activityRegistry.listDefinitions(),
    );
  } catch {
    return { ok: false, reasons: ['manifest-build-failed'] };
  }

  const expectedManifest = buildExpectedManifest(descriptor, actualManifest);
  const verdict = checkWorkflowCompatibility(
    expectedManifest,
    actualManifest,
    DEFAULT_WORKFLOW_COMPATIBILITY_POLICY,
  );
  if (!verdict.compatible) {
    return { ok: false, reasons: verdict.reasons };
  }

  return {
    ok: true,
    manifest: actualManifest,
    definition: registeredDefinition,
    activityRegistry,
    loadedDefinition,
  };
}
