/**
 * Structured compatibility verdicts between two workflow revision manifests.
 *
 * `checkWorkflowCompatibility()` answers "may `candidate` automatically
 * activate in place of `current`" as a bounded, machine-readable
 * {@link WorkflowCompatibilityVerdict} rather than a thrown error or a bare
 * boolean—a catalog or refresh orchestrator can report every reason a
 * candidate revision was rejected, but never override one during automatic
 * activation (the reasons are policy-fixed except for one deliberate knob,
 * see {@link WorkflowCompatibilityPolicy}).
 *
 * The five reasons this module can report mirror, and in one case literally
 * call, checks that already exist elsewhere in the codebase rather than
 * reinventing them:
 *
 * - `workflow-version-incompatible` calls {@link checkVersionCompatibility}
 *   from `core/versioning.ts`—the exact primitive
 *   `derivePreparedExecutionState()` (`core/engine/lifecycle/persist.ts`)
 *   already uses to reject a stored checkpoint against a re-registered
 *   workflow. This module never modifies that primitive; it reuses it as-is
 *   so the two answers can never disagree.
 * - `contract-hash-mismatch` and `manifest-version-unsupported` reuse the
 *   same names `parseWorkflowRevisionManifest()`
 *   (`WorkflowRevisionManifestRejectionReason`, `./failure.ts`) already uses
 *   for structurally similar situations—hostile-input rejection there,
 *   activation compatibility here. The two unions are intentionally
 *   independent; the shared literal is vocabulary reuse, not a coupling.
 *
 * `checkWorkflowCompatibility()` is pure and synchronous: both manifests
 * already carry their computed `contractHash`/`revision`, so no hashing
 * happens here.
 *
 * @module core/contract/compatibility
 */

import { checkVersionCompatibility } from '../versioning.ts';
import type { WorkflowRevisionManifest } from './types.ts';
import { WORKFLOW_REVISION_MANIFEST_VERSION } from './types.ts';

/**
 * One bounded, machine-readable reason `candidate` is not compatible with
 * `current`. Closed union, safe to use as a metric label—exactly the five
 * reasons named by the Activation Compatibility issue, in the fixed order
 * {@link checkWorkflowCompatibility} evaluates and reports them.
 *
 * @example
 * ```ts
 * import type { WorkflowCompatibilityReason } from '@lostgradient/weft';
 *
 * const counts = new Map<WorkflowCompatibilityReason, number>();
 * counts.set('contract-hash-mismatch', 1);
 * console.log(counts.get('contract-hash-mismatch'));
 * ```
 */
export type WorkflowCompatibilityReason =
  | 'name-mismatch'
  | 'manifest-version-unsupported'
  | 'contract-hash-mismatch'
  | 'workflow-version-incompatible'
  | 'artifact-revision-mismatch';

/**
 * The structured result of {@link checkWorkflowCompatibility}: either fully
 * compatible, or incompatible with the complete, ordered list of every
 * applicable {@link WorkflowCompatibilityReason}—never just the first one
 * found. A refresh orchestrator may report every reason here; it may never
 * treat an incompatible verdict as compatible during automatic activation.
 *
 * @example
 * ```ts
 * import type { WorkflowCompatibilityVerdict } from '@lostgradient/weft';
 *
 * const verdict: WorkflowCompatibilityVerdict = {
 *   compatible: false,
 *   reasons: ['contract-hash-mismatch'],
 * };
 * console.log(verdict.compatible ? 'ok' : verdict.reasons.join(', '));
 * ```
 */
export type WorkflowCompatibilityVerdict =
  | Readonly<{ compatible: true }>
  | Readonly<{ compatible: false; reasons: readonly WorkflowCompatibilityReason[] }>;

/**
 * Declared compatibility policy accepted by {@link checkWorkflowCompatibility}.
 *
 * `requireExactRevision` is the *only* tunable axis. `name-mismatch`,
 * `manifest-version-unsupported`, `contract-hash-mismatch`, and
 * `workflow-version-incompatible` can never be loosened by policy—a
 * refresh system may report those reasons but may not override them during
 * automatic activation, which is the literal mechanism the Activation
 * Compatibility issue asks for.
 *
 * - `true` (the strict default): a candidate whose `revision` differs from
 *   `current`'s—even when `contractHash` is identical, i.e. the only
 *   difference is a documentation-only field (`contract.description` or
 *   `contract.tags`, since `contractHash` deliberately excludes both) —
 *   reports `artifact-revision-mismatch` and is not compatible.
 * - `false`: a `revision`-only difference is tolerated; `artifact-revision-mismatch`
 *   is never reported. A `contractHash` difference always implies a
 *   `revision` difference too (the full contract hash a `revision` covers a
 *   strict superset of what `contractHash` covers), so `contract-hash-mismatch`
 *   is unaffected by this setting and still blocks activation on its own.
 *
 * @example
 * ```ts
 * import type { WorkflowCompatibilityPolicy } from '@lostgradient/weft';
 *
 * const lenient: WorkflowCompatibilityPolicy = { requireExactRevision: false };
 * console.log(lenient.requireExactRevision);
 * ```
 */
export interface WorkflowCompatibilityPolicy {
  /**
   * Whether an exact `revision` match is required for compatibility, on top
   * of the four never-tunable reasons. Defaults to `true` when omitted or
   * when the policy object itself omits the field.
   */
  requireExactRevision?: boolean;
}

/**
 * The strict default policy `checkWorkflowCompatibility` uses when no
 * policy argument is supplied. Exported so a catalog can name the default
 * explicitly—in a log line, a configuration default, a test fixture —
 * rather than relying on an implicit fallback.
 *
 * @example
 * ```ts
 * import { DEFAULT_WORKFLOW_COMPATIBILITY_POLICY } from '@lostgradient/weft';
 *
 * console.log(DEFAULT_WORKFLOW_COMPATIBILITY_POLICY.requireExactRevision); // true
 * ```
 */
export const DEFAULT_WORKFLOW_COMPATIBILITY_POLICY: Required<WorkflowCompatibilityPolicy> = {
  requireExactRevision: true,
};

/**
 * Whether a raw `manifestVersion` value matches the schema version this
 * build understands. Routed through a `number`-typed helper rather than
 * compared inline: a genuine {@link WorkflowRevisionManifest}'s
 * `manifestVersion` is typed as the literal `typeof WORKFLOW_REVISION_MANIFEST_VERSION`,
 * so an inline `!==` comparison against that same literal is a same-literal
 * check TypeScript/oxlint can flag as always-false. No real producer in this
 * codebase can construct a `WorkflowRevisionManifest` with an unsupported
 * `manifestVersion`—{@link buildWorkflowRevisionManifest} and
 * {@link parseWorkflowRevisionManifest} both guarantee it—so this branch
 * is only reachable through a structurally-invalid, explicitly cast value in
 * a test.
 */
function isSupportedWorkflowRevisionManifestVersion(version: number): boolean {
  return version === WORKFLOW_REVISION_MANIFEST_VERSION;
}

/** Each never-tunable check, isolated so {@link checkWorkflowCompatibility} stays a flat list of reasons. */
function isNameMismatch(
  current: WorkflowRevisionManifest,
  candidate: WorkflowRevisionManifest,
): boolean {
  return current.name !== candidate.name;
}

function isManifestVersionUnsupported(
  current: WorkflowRevisionManifest,
  candidate: WorkflowRevisionManifest,
): boolean {
  return (
    !isSupportedWorkflowRevisionManifestVersion(current.manifestVersion) ||
    !isSupportedWorkflowRevisionManifestVersion(candidate.manifestVersion)
  );
}

function isContractHashMismatch(
  current: WorkflowRevisionManifest,
  candidate: WorkflowRevisionManifest,
): boolean {
  return current.contractHash !== candidate.contractHash;
}

function isWorkflowVersionIncompatible(
  current: WorkflowRevisionManifest,
  candidate: WorkflowRevisionManifest,
): boolean {
  return (
    checkVersionCompatibility(candidate.workflowVersion, current.workflowVersion) === 'incompatible'
  );
}

function isArtifactRevisionMismatch(
  current: WorkflowRevisionManifest,
  candidate: WorkflowRevisionManifest,
): boolean {
  return current.revision !== candidate.revision;
}

/**
 * Compare two workflow revision manifests and report whether `candidate` is
 * compatible with `current`—the pure comparison behind automatic
 * activation. Symmetric: `checkWorkflowCompatibility(a, b, policy)` and
 * `checkWorkflowCompatibility(b, a, policy)` always agree, since every
 * underlying check is an equality or bounded-value comparison with no
 * directionality.
 *
 * Every applicable reason is collected and returned in the fixed order
 * `name-mismatch`, `manifest-version-unsupported`, `contract-hash-mismatch`,
 * `workflow-version-incompatible`, `artifact-revision-mismatch`—the
 * function never short-circuits on the first reason found.
 *
 * @example
 * ```ts
 * import {
 *   buildWorkflowContract,
 *   buildWorkflowRevisionManifest,
 *   checkWorkflowCompatibility,
 * } from '@lostgradient/weft';
 *
 * const current = await buildWorkflowRevisionManifest(
 *   buildWorkflowContract({ name: 'checkout', version: '1.0.0' }),
 * );
 * const candidate = await buildWorkflowRevisionManifest(
 *   buildWorkflowContract({ name: 'checkout', version: '2.0.0' }),
 * );
 *
 * const verdict = checkWorkflowCompatibility(current, candidate);
 * console.log(verdict.compatible); // false
 * ```
 */
export function checkWorkflowCompatibility(
  current: WorkflowRevisionManifest,
  candidate: WorkflowRevisionManifest,
  policy: WorkflowCompatibilityPolicy = DEFAULT_WORKFLOW_COMPATIBILITY_POLICY,
): WorkflowCompatibilityVerdict {
  const requireExactRevision = policy.requireExactRevision ?? true;
  const reasons: WorkflowCompatibilityReason[] = [];

  if (isNameMismatch(current, candidate)) {
    reasons.push('name-mismatch');
  }
  if (isManifestVersionUnsupported(current, candidate)) {
    reasons.push('manifest-version-unsupported');
  }
  if (isContractHashMismatch(current, candidate)) {
    reasons.push('contract-hash-mismatch');
  }
  if (isWorkflowVersionIncompatible(current, candidate)) {
    reasons.push('workflow-version-incompatible');
  }
  if (requireExactRevision && isArtifactRevisionMismatch(current, candidate)) {
    reasons.push('artifact-revision-mismatch');
  }

  return reasons.length === 0 ? { compatible: true } : { compatible: false, reasons };
}
