/**
 * The stale-generation and compatibility refusal gates
 * `WorkflowCatalog.activateCandidate()` checks before ever attempting its
 * CAS write — split out of `workflow-catalog.ts` to protect that file's
 * size against the repository's 500-line implementation-file ceiling,
 * mirroring how `storage-io.ts`/`codec.ts`/`removal.ts` already sit
 * alongside it rather than inline.
 *
 * @module core/catalog/activation-guards
 */

import {
  checkWorkflowCompatibility,
  DEFAULT_WORKFLOW_COMPATIBILITY_POLICY,
  type WorkflowCompatibilityPolicy,
} from '../contract/compatibility.ts';
import type { WorkflowRevisionManifest } from '../contract/types.ts';
import { WorkflowCatalogActiveEntryMissingError } from './errors.ts';
import type {
  WorkflowCatalogActivationResult,
  WorkflowCatalogActivePointer,
  WorkflowRevisionRecord,
} from './types.ts';

/** Options accepted by {@link import('./workflow-catalog.ts').WorkflowCatalog.activateCandidate}. */
export type ActivateCandidateOptions = {
  /** The generation this caller last observed; refused with `stale-generation` if it disagrees with the durable pointer. */
  expectedGeneration?: number;
  /** Compatibility policy; defaults to {@link DEFAULT_WORKFLOW_COMPATIBILITY_POLICY}. */
  policy?: WorkflowCompatibilityPolicy;
};

/**
 * The stale-generation and compatibility gates `activateCandidate` checks
 * before ever attempting a write. Returns the refusal result when the
 * candidate should be rejected, or `undefined` when it may proceed to the
 * CAS write. `resolveEntry` is threaded through rather than a `WorkflowCatalog`
 * instance, so this module never needs to import the class itself.
 */
export async function refuseIncompatibleOrStaleCandidate(
  resolveEntry: (name: string, revision: string) => Promise<WorkflowRevisionRecord | undefined>,
  name: string,
  candidateManifest: WorkflowRevisionManifest,
  currentPointer: WorkflowCatalogActivePointer | null,
  options?: ActivateCandidateOptions,
): Promise<WorkflowCatalogActivationResult | undefined> {
  if (currentPointer === null) {
    return refuseStaleFirstActivation(options);
  }

  const generationRefusal = refuseMissingOrStaleGeneration(currentPointer, options);
  if (generationRefusal !== undefined) return generationRefusal;

  return refuseIncompatibleCandidate(
    resolveEntry,
    name,
    candidateManifest,
    currentPointer,
    options,
  );
}

/**
 * First-ever activation of a name (no active pointer yet): omitting
 * `expectedGeneration` (or supplying exactly 0, the "no prior generation"
 * value) bypasses the fence entirely — there is nothing to be stale
 * against yet, and the one existing test that calls `activateCandidate`
 * with no options at all must keep applying. Any OTHER explicit value is
 * a caller assertion about a generation that does not exist.
 */
function refuseStaleFirstActivation(
  options?: ActivateCandidateOptions,
): WorkflowCatalogActivationResult | undefined {
  if (options?.expectedGeneration !== undefined && options.expectedGeneration !== 0) {
    return { applied: false, reason: 'stale-generation', currentGeneration: 0 };
  }
  return undefined;
}

/**
 * The generation fence for an existing active pointer: an omitted
 * `expectedGeneration` is exactly the "two refreshers silently
 * last-write-win" hazard this gate exists to close, so it is refused
 * rather than falling through to the compatibility check alone; a
 * supplied-but-wrong generation is refused as stale.
 */
function refuseMissingOrStaleGeneration(
  currentPointer: WorkflowCatalogActivePointer,
  options?: ActivateCandidateOptions,
): WorkflowCatalogActivationResult | undefined {
  if (options?.expectedGeneration === undefined) {
    return {
      applied: false,
      reason: 'expected-generation-required',
      currentGeneration: currentPointer.generation,
    };
  }
  if (options.expectedGeneration !== currentPointer.generation) {
    return {
      applied: false,
      reason: 'stale-generation',
      currentGeneration: currentPointer.generation,
    };
  }
  return undefined;
}

/**
 * The compatibility check itself, run once the generation fence has
 * passed. Resolves the active entry via `resolveEntry` (cache then durable
 * read-through), never a synchronous cache-only lookup — a second process
 * can durably activate a revision this cache never saw. A durable miss too
 * fails closed with {@link WorkflowCatalogActiveEntryMissingError}.
 */
async function refuseIncompatibleCandidate(
  resolveEntry: (name: string, revision: string) => Promise<WorkflowRevisionRecord | undefined>,
  name: string,
  candidateManifest: WorkflowRevisionManifest,
  currentPointer: WorkflowCatalogActivePointer,
  options?: ActivateCandidateOptions,
): Promise<WorkflowCatalogActivationResult | undefined> {
  const currentEntry = await resolveEntry(name, currentPointer.revision);
  if (currentEntry === undefined) {
    throw new WorkflowCatalogActiveEntryMissingError(name, currentPointer.revision);
  }

  const verdict = checkWorkflowCompatibility(
    currentEntry.manifest,
    candidateManifest,
    options?.policy ?? DEFAULT_WORKFLOW_COMPATIBILITY_POLICY,
  );
  return verdict.compatible ? undefined : { applied: false, reason: 'incompatible', verdict };
}
