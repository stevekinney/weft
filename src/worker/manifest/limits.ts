/**
 * Semantic bounds applied to a worker manifest before it is normalized,
 * digested, or admitted to a registry.
 *
 * Lives in a leaf module so the type declarations, the hostile-input parser,
 * and the canonical serializer can all depend on the limits without forming an
 * import cycle — the same placement rationale as `worker/protocol-version`.
 *
 * These limits are deliberately separate from the transport's raw frame
 * ceiling. A WebSocket frame guard bounds allocation; these bound the
 * *semantic* shape a worker may assert, which is what keeps registry
 * insertion, diagnostics, and key construction predictable.
 *
 * @module worker/manifest/limits
 */

/**
 * Maximum UTF-8 byte length of any single identifier-shaped manifest string —
 * deployment name, build ID, artifact digest, runtime name/version, SDK
 * version, workflow/activity key, workflow revision, or contract hash.
 *
 * Measured in bytes rather than code units so an astral-plane string cannot
 * carry four times the intended payload.
 *
 * @example
 * ```ts
 * import { MAX_MANIFEST_IDENTIFIER_BYTES } from '@lostgradient/weft';
 *
 * const buildId = 'release-2026.08.18';
 * const fits = new TextEncoder().encode(buildId).byteLength <= MAX_MANIFEST_IDENTIFIER_BYTES;
 * console.log(fits); // true
 * ```
 */
export const MAX_MANIFEST_IDENTIFIER_BYTES = 512;

/**
 * Maximum number of workflow entries one manifest may advertise.
 *
 * @example
 * ```ts
 * import { MAX_MANIFEST_WORKFLOW_COUNT } from '@lostgradient/weft';
 *
 * const advertised = ['checkout', 'refund'];
 * console.log(advertised.length <= MAX_MANIFEST_WORKFLOW_COUNT); // true
 * ```
 */
export const MAX_MANIFEST_WORKFLOW_COUNT = 512;

/**
 * Maximum number of activity entries within one workflow entry.
 *
 * @example
 * ```ts
 * import { MAX_MANIFEST_ACTIVITY_COUNT } from '@lostgradient/weft';
 *
 * console.log(MAX_MANIFEST_ACTIVITY_COUNT >= 1); // true
 * ```
 */
export const MAX_MANIFEST_ACTIVITY_COUNT = 512;

/**
 * Maximum number of keys in the manifest `capabilities` record.
 *
 * @example
 * ```ts
 * import { MAX_MANIFEST_CAPABILITY_COUNT } from '@lostgradient/weft';
 *
 * const capabilities = { gpu: true, region: 'us-east-1' };
 * console.log(Object.keys(capabilities).length <= MAX_MANIFEST_CAPABILITY_COUNT); // true
 * ```
 */
export const MAX_MANIFEST_CAPABILITY_COUNT = 64;

/**
 * Maximum nesting depth permitted inside a single `capabilities` value.
 *
 * Depth 1 is a scalar. `isJSONValue()` is cycle-safe but unbounded, so the
 * manifest parser imposes this itself rather than delegating.
 *
 * @example
 * ```ts
 * import { MAX_MANIFEST_CAPABILITY_DEPTH } from '@lostgradient/weft';
 *
 * // { limits: { cpu: 4 } } is depth 3: object, object, scalar.
 * console.log(3 <= MAX_MANIFEST_CAPABILITY_DEPTH); // true
 * ```
 */
export const MAX_MANIFEST_CAPABILITY_DEPTH = 8;

/**
 * Maximum UTF-8 byte length of any single string inside `capabilities`.
 *
 * @example
 * ```ts
 * import { MAX_MANIFEST_CAPABILITY_STRING_BYTES } from '@lostgradient/weft';
 *
 * const note = 'gpu pool: a100';
 * console.log(note.length <= MAX_MANIFEST_CAPABILITY_STRING_BYTES); // true
 * ```
 */
export const MAX_MANIFEST_CAPABILITY_STRING_BYTES = 4096;

/**
 * Maximum UTF-8 byte length of the canonical normalized manifest.
 *
 * Checked against the canonical serialization — not the received bytes — so a
 * worker cannot evade the bound with whitespace-minimized input and then
 * expand under normalization.
 *
 * @example
 * ```ts
 * import { canonicalWorkerManifestJson, MAX_NORMALIZED_MANIFEST_BYTES } from '@lostgradient/weft';
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
 * console.log(canonical.length <= MAX_NORMALIZED_MANIFEST_BYTES); // true
 * ```
 */
export const MAX_NORMALIZED_MANIFEST_BYTES = 262_144;

/**
 * Maximum structural nesting depth the pre-parse duplicate-key scanner will
 * follow into raw JSON text.
 *
 * The scanner pushes one entry onto an open-container stack per `{`/`[`
 * encountered, before `JSON.parse` ever runs. Without a ceiling here, a run
 * of open-brace characters well under the transport frame limit forces
 * millions of allocations. No legitimate manifest — workflows, activities,
 * and an 8-deep `capabilities` value — nests anywhere close to this bound.
 *
 * @example
 * ```ts
 * import { MAX_JSON_SCAN_NESTING_DEPTH } from '@lostgradient/weft';
 *
 * console.log(MAX_JSON_SCAN_NESTING_DEPTH >= 16); // true
 * ```
 */
export const MAX_JSON_SCAN_NESTING_DEPTH = 64;
