/**
 * Build a {@link WorkflowRevisionManifest} from a normalized contract.
 *
 * @module core/contract/manifest
 */

import { contractHash } from './hash.ts';
import { MAX_CONTRACT_IDENTIFIER_BYTES } from './limits.ts';
import { normalizeWorkflowContract } from './normalize.ts';
import { deriveWorkflowRevision } from './revision.ts';
import type { WorkflowContract, WorkflowRevisionManifest } from './types.ts';
import { WORKFLOW_REVISION_MANIFEST_VERSION } from './types.ts';

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

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

  return {
    manifestVersion: WORKFLOW_REVISION_MANIFEST_VERSION,
    name: normalized.name,
    workflowVersion: normalized.workflowVersion,
    revision,
    contractHash: hash,
    contract: normalized,
  };
}
