/**
 * Placeholder content-identity digest shared by every manifest builder that
 * has no real build-tool-supplied digest to report yet.
 *
 * @module worker/manifest/declared-shape-digest
 */

import { hashString } from '../../runtime/portable.ts';

/**
 * Tag a derived placeholder value so it is never mistaken for a real,
 * build-tool-supplied content digest. `hashString` is FNV-1a — cache-key
 * quality, not cryptographic — which is exactly why the tag exists: a reader
 * (or a future deterministic builder) can tell a `declared-shape:` value
 * apart from a trusted `sha256:` one at a glance.
 */
export function declaredShapeDigest(input: string): string {
  return `declared-shape:${hashString(input)}`;
}
