/**
 * Build a {@link WorkflowRevisionManifest} from a normalized contract.
 *
 * @module core/contract/manifest
 */

import { utf8ByteLength } from '../../worker/manifest/utf8.ts';
import { contractHash } from './hash.ts';
import { MAX_CONTRACT_IDENTIFIER_BYTES } from './limits.ts';
import { parseWorkflowRevisionManifest } from './manifest-parse.ts';
import { normalizeWorkflowContract } from './normalize.ts';
import { deriveWorkflowRevision } from './revision.ts';
import type { WorkflowContract, WorkflowRevisionManifest } from './types.ts';
import { WORKFLOW_REVISION_MANIFEST_VERSION } from './types.ts';

/**
 * Options accepted by {@link buildWorkflowRevisionManifest}.
 *
 * @example
 * ```ts
 * import type { BuildWorkflowRevisionManifestOptions } from '@lostgradient/weft';
 *
 * const options: BuildWorkflowRevisionManifestOptions = { revision: 'deploy-2026.09.01' };
 * console.log(options.revision);
 * ```
 */
export interface BuildWorkflowRevisionManifestOptions {
  /**
   * Explicit opaque revision identity. When omitted, `revision` is derived
   * from the full contract via {@link deriveWorkflowRevision}. An empty
   * string, or a string exceeding `MAX_CONTRACT_IDENTIFIER_BYTES`, is
   * rejected rather than silently falling back to derivation.
   */
  revision?: string;
}

/**
 * Build a {@link WorkflowRevisionManifest} for a workflow contract.
 *
 * Normalizes the contract, computes `contractHash`, and either derives
 * `revision` (the default) or validates and preserves an explicitly
 * supplied one.
 *
 * Throws a plain `Error` when `options.revision` is present but empty, or
 * exceeds `MAX_CONTRACT_IDENTIFIER_BYTES` — a caller-supplied identity is
 * validated the same way any other contract identifier is, since it becomes
 * part of the manifest a consumer will trust.
 *
 * **Round-trips through {@link parseWorkflowRevisionManifest} before
 * returning.** A manifest this function builds but its own parser would
 * reject (`identifier-too-long`, `too-many-entries`, `manifest-too-large`)
 * is a build-time bug, not a runtime condition to defer to whoever later
 * reads the manifest back — see WFT-5 PR #943 review thread
 * PRRT_kwDORwthfM6eWFwv. Throws a plain `Error` describing the rejection
 * reason when that happens.
 *
 * @example
 * ```ts
 * import { buildWorkflowContract, buildWorkflowRevisionManifest } from '@lostgradient/weft';
 *
 * const contract = buildWorkflowContract({ name: 'checkout', version: '2.1.0' });
 * const manifest = await buildWorkflowRevisionManifest(contract);
 * console.log(manifest.name, manifest.contractHash.startsWith('sha256:'));
 * ```
 */
export async function buildWorkflowRevisionManifest(
  contract: WorkflowContract,
  options?: BuildWorkflowRevisionManifestOptions,
): Promise<WorkflowRevisionManifest> {
  const normalized = normalizeWorkflowContract(contract);
  const hash = await contractHash(normalized);

  let revision: string;
  if (options?.revision !== undefined) {
    if (options.revision.length === 0) {
      throw new Error(
        'buildWorkflowRevisionManifest: options.revision must not be an empty string',
      );
    }
    const bytes = utf8ByteLength(options.revision);
    if (bytes > MAX_CONTRACT_IDENTIFIER_BYTES) {
      throw new Error(
        `buildWorkflowRevisionManifest: options.revision is ${bytes} bytes, exceeding the maximum identifier size of ${MAX_CONTRACT_IDENTIFIER_BYTES}`,
      );
    }
    revision = options.revision;
  } else {
    revision = await deriveWorkflowRevision(normalized);
  }

  const manifest: WorkflowRevisionManifest = {
    manifestVersion: WORKFLOW_REVISION_MANIFEST_VERSION,
    name: normalized.name,
    workflowVersion: normalized.workflowVersion,
    revision,
    contractHash: hash,
    contract: normalized,
  };

  const parsed = await parseWorkflowRevisionManifest(manifest);
  if (!parsed.ok) {
    throw new Error(
      `buildWorkflowRevisionManifest: built manifest fails parseWorkflowRevisionManifest ` +
        `validation (${parsed.reason}${parsed.path === undefined ? '' : ` at ${parsed.path}`}): ` +
        parsed.message,
    );
  }
  return parsed.manifest;
}
