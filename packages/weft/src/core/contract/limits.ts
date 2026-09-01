/**
 * Semantic bounds applied to a workflow contract before it is normalized,
 * hashed, or admitted as a {@link WorkflowRevisionManifest}.
 *
 * Sized analogously to `src/worker/manifest/limits.ts` — the same
 * placement rationale applies: the type declarations, the hostile-input
 * manifest parser, and the canonical serializer can all depend on these
 * limits without forming an import cycle.
 *
 * @module core/contract/limits
 */

/**
 * Maximum UTF-8 byte length of any single identifier-shaped contract string —
 * workflow/signal/update/query/activity name, `workflowVersion`, or an
 * explicitly supplied `revision`.
 *
 * @example
 * ```ts
 * import { MAX_CONTRACT_IDENTIFIER_BYTES } from '@lostgradient/weft';
 *
 * const name = 'checkout';
 * const fits = new TextEncoder().encode(name).byteLength <= MAX_CONTRACT_IDENTIFIER_BYTES;
 * console.log(fits); // true
 * ```
 */
export const MAX_CONTRACT_IDENTIFIER_BYTES = 512;

/**
 * Maximum number of entries in any one of a contract's `signals`, `updates`,
 * `queries`, or `activities` records.
 *
 * @example
 * ```ts
 * import { MAX_CONTRACT_MESSAGE_COUNT } from '@lostgradient/weft';
 *
 * const signals = ['approved', 'rejected'];
 * console.log(signals.length <= MAX_CONTRACT_MESSAGE_COUNT); // true
 * ```
 */
export const MAX_CONTRACT_MESSAGE_COUNT = 512;

/**
 * Maximum nesting depth permitted inside one schema fragment
 * (`inputSchema`/`outputSchema`).
 *
 * Mirrors `codegen-emit.ts`'s `MAX_RECURSION_DEPTH`. `isJSONValue()` and
 * `canonicalJsonStringify()` are both unbounded recursion over their input,
 * so {@link parseWorkflowRevisionManifest} enforces this bound itself,
 * iteratively, before either ever walks an untrusted schema fragment.
 *
 * @example
 * ```ts
 * import { MAX_CONTRACT_SCHEMA_DEPTH } from '@lostgradient/weft';
 *
 * console.log(MAX_CONTRACT_SCHEMA_DEPTH >= 16); // true
 * ```
 */
export const MAX_CONTRACT_SCHEMA_DEPTH = 64;

/**
 * Maximum UTF-8 byte length of the canonical, normalized contract JSON.
 *
 * Checked against the canonical serialization — not the received bytes — so
 * a compact payload cannot evade the bound and then expand under
 * normalization.
 *
 * @example
 * ```ts
 * import { buildWorkflowContract, canonicalWorkflowContractJson, MAX_NORMALIZED_CONTRACT_BYTES } from '@lostgradient/weft';
 *
 * const canonical = canonicalWorkflowContractJson(
 *   buildWorkflowContract({ name: 'checkout', version: '2.1.0' }),
 * );
 * console.log(canonical.length <= MAX_NORMALIZED_CONTRACT_BYTES); // true
 * ```
 */
export const MAX_NORMALIZED_CONTRACT_BYTES = 262_144;
