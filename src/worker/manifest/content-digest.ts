/**
 * Generic SHA-256 content digest, tagged with its algorithm.
 *
 * Extracted from the manifest digest so any canonical-JSON content — not
 * only a full {@link WorkerManifest} — can be hashed with the same
 * collision-resistant, algorithm-tagged scheme. `hashString` (FNV-1a) stays
 * reserved for cache-key-quality placeholders; anything a host trusts as a
 * real content identity goes through this function instead.
 *
 * @module worker/manifest/content-digest
 */

import { copyBytesToArrayBuffer } from '../../core/byte-arrays.ts';
import { utf8Encode } from './utf8.ts';

/**
 * Algorithm tag prefixed to every digest this function produces.
 *
 * Carrying the algorithm in the value means a future change reads as a
 * difference rather than as a silent reinterpretation of the same hex.
 */
export const CONTENT_DIGEST_ALGORITHM = 'sha256';

function bytesToHex(bytes: Uint8Array): string {
  let hex = '';
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, '0');
  }
  return hex;
}

/** Digest a UTF-8 string with SHA-256, returning `sha256:<hex>`. */
export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', copyBytesToArrayBuffer(utf8Encode(input)));
  return `${CONTENT_DIGEST_ALGORITHM}:${bytesToHex(new Uint8Array(digest))}`;
}
