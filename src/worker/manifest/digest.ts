/**
 * Content-addressed digest of a worker manifest.
 *
 * The digest is what `(deploymentName, buildId)` consistency, registration
 * acknowledgement, and persisted execution provenance all compare, so a
 * collision would let two different workers pass for one another. That rules
 * out the repository's FNV-1a helpers, which are documented as cache-key
 * quality, and calls for SHA-256 — the same choice, and the same
 * bounded-input-then-hash shape, as the worker replay signature.
 *
 * The digest carries its algorithm as a prefix so a future change is a
 * readable difference rather than a silent reinterpretation of 64 hex
 * characters.
 *
 * @module worker/manifest/digest
 */

import { copyBytesToArrayBuffer } from '../../core/byte-arrays.ts';
import { canonicalWorkerManifestJson } from './normalize.ts';
import type { WorkerManifest } from './types.ts';
import { utf8Encode } from './utf8.ts';

/**
 * Algorithm tag prefixed to every manifest digest this version produces.
 *
 * Carrying the algorithm in the value means a future change reads as a
 * difference rather than as a silent reinterpretation of the same hex.
 *
 * @example
 * ```ts
 * import { WORKER_MANIFEST_DIGEST_ALGORITHM } from '@lostgradient/weft';
 *
 * const digest = 'sha256:41d0e2';
 * console.log(digest.startsWith(`${WORKER_MANIFEST_DIGEST_ALGORITHM}:`)); // true
 * ```
 */
export const WORKER_MANIFEST_DIGEST_ALGORITHM = 'sha256';

function bytesToHex(bytes: Uint8Array): string {
  let hex = '';
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, '0');
  }
  return hex;
}

/**
 * Digest canonical manifest bytes.
 *
 * Separate from {@link computeWorkerManifestDigest} so a caller that already
 * holds the canonical serialization — the manifest parser returns one — does
 * not serialize the manifest twice.
 *
 * @example
 * ```ts
 * import { canonicalWorkerManifestJson, digestCanonicalWorkerManifest } from '@lostgradient/weft';
 *
 * const canonical = canonicalWorkerManifestJson({
 *   manifestVersion: 1,
 *   protocolVersion: 2,
 *   sdkVersion: '0.18.0',
 *   runtime: { name: 'bun', version: '1.3.14' },
 *   deployment: { name: 'billing', buildId: 'b3', artifactDigest: 'sha256:41d0' },
 *   workflows: {},
 *   capabilities: {},
 * });
 *
 * console.log((await digestCanonicalWorkerManifest(canonical)).startsWith('sha256:'));
 * ```
 */
export async function digestCanonicalWorkerManifest(canonicalJson: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    copyBytesToArrayBuffer(utf8Encode(canonicalJson)),
  );
  return `${WORKER_MANIFEST_DIGEST_ALGORITHM}:${bytesToHex(new Uint8Array(digest))}`;
}

/**
 * Compute the content-addressed digest of a worker manifest.
 *
 * Determined entirely by canonical content, so two manifests that differ only
 * in key order digest identically, and any difference the host cares about
 * changes the digest.
 *
 * @example
 * ```ts
 * import { computeWorkerManifestDigest, WORKER_MANIFEST_VERSION } from '@lostgradient/weft';
 *
 * const digest = await computeWorkerManifestDigest({
 *   manifestVersion: WORKER_MANIFEST_VERSION,
 *   protocolVersion: 2,
 *   sdkVersion: '0.18.0',
 *   runtime: { name: 'bun', version: '1.3.14' },
 *   deployment: { name: 'billing', buildId: 'b3', artifactDigest: 'sha256:41d0' },
 *   workflows: {},
 *   capabilities: {},
 * });
 *
 * console.log(digest.startsWith('sha256:')); // true
 * ```
 */
export async function computeWorkerManifestDigest(manifest: WorkerManifest): Promise<string> {
  return digestCanonicalWorkerManifest(canonicalWorkerManifestJson(manifest));
}
