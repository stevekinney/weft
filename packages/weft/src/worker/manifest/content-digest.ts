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

import { sha256 } from '@noble/hashes/sha2.js';

import { copyBytesToArrayBuffer } from "../../embedded/backchannel/src/internals.ts";
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

/**
 * Digest a UTF-8 string with SHA-256, returning `sha256:<hex>`.
 *
 * Prefers `crypto.subtle`, which browsers expose only in secure contexts.
 * An operator console served over plain HTTP still derives
 * activity contract hashes in the browser, so without SubtleCrypto the same
 * digest comes from `@noble/hashes`' portable SHA-256.
 */
export async function sha256Hex(input: string): Promise<string> {
  const bytes = utf8Encode(input);
  const subtle = globalThis.crypto?.subtle as SubtleCrypto | undefined;
  const digest =
    subtle === undefined
      ? sha256(bytes)
      : new Uint8Array(await subtle.digest('SHA-256', copyBytesToArrayBuffer(bytes)));
  return `${CONTENT_DIGEST_ALGORITHM}:${bytesToHex(digest)}`;
}

/**
 * Synchronous counterpart to {@link sha256Hex}, same algorithm and output
 * format (`sha256:<hex>`) — via `node:crypto`'s `createHash`, not
 * `crypto.subtle.digest`. `subtle.digest` completes through a real
 * event-loop turn (a native async completion, not a plain microtask chain),
 * which is fine for work a caller genuinely `await`s but is a structural
 * hazard for a value computed inside a fire-and-forget commit path — of
 * which the durable task ledger's runtime (`core/task-ledger/task-attempt-runtime.ts`)
 * has several by design (a WebSocket message handler, or a worker-disconnect
 * handler, must return immediately rather than block on a durable write).
 * Reaches the identical SHA-256 digest with no async gap at all, so it never
 * races a caller (production or test) that does not itself await the
 * eventual write settling.
 */
export function sha256HexSync(input: string): string {
  const { createHash } = process.getBuiltinModule('node:crypto');
  const digest = createHash('sha256').update(utf8Encode(input)).digest('hex');
  return `${CONTENT_DIGEST_ALGORITHM}:${digest}`;
}
