/**
 * Manifest validation starting from raw JSON text.
 *
 * Wire callers that still hold the received text should use this entry point
 * rather than `JSON.parse` followed by {@link parseWorkerManifest}: duplicate
 * object keys are only visible before parsing, and silently taking the last
 * one would let a worker present two different artifact digests in one
 * payload.
 *
 * @module worker/manifest/parse-json
 */

import { manifestFailure } from './failure.ts';
import { findDuplicateJsonKey } from './json-scan.ts';
import { parseWorkerManifest, type WorkerManifestParseResult } from './parse.ts';

/**
 * Validate an untrusted worker manifest from JSON text.
 *
 * @example
 * ```ts
 * import { parseWorkerManifestJson } from '@lostgradient/weft';
 *
 * const result = parseWorkerManifestJson('{"manifestVersion":1,"manifestVersion":2}');
 * console.log(result.ok ? 'accepted' : result.reason); // 'duplicate_key'
 * ```
 */
export function parseWorkerManifestJson(text: string): WorkerManifestParseResult {
  const duplicate = findDuplicateJsonKey(text);
  if (duplicate !== undefined) {
    return manifestFailure(
      'duplicate_key',
      `manifest JSON declares the key ${JSON.stringify(duplicate)} more than once`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // The parser's own message can quote manifest content, so it is dropped
    // rather than forwarded to a worker-facing rejection.
    return manifestFailure('invalid_json', 'manifest must be valid JSON');
  }

  return parseWorkerManifest(parsed);
}
