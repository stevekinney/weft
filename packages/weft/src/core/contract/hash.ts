/**
 * Content-addressed digests of a workflow contract's public payload.
 *
 * `contractHash()` answers "which public payload contract does this
 * revision implement" — it excludes `name`, `workflowVersion`,
 * `description`, and `tags`, which identify the workflow and describe it in
 * prose rather than describe what callers may send and get back. That
 * exclusion is what lets a documentation edit change `deriveWorkflowRevision()`'s
 * broader identity (see `revision.ts`) without changing `contractHash()`.
 *
 * `digestCanonicalWorkflowContract()` is a generic "digest this canonical
 * JSON text" primitive shared by both identities: which identity a caller
 * gets back depends entirely on which canonical serializer produced the
 * text handed to it — `canonicalWorkflowContractJson()`'s full-identity
 * output yields the same digest `deriveWorkflowRevision()` returns; this
 * module's internal payload-only serializer is what `contractHash()` feeds
 * it. Treat it as a shared digesting primitive, not as itself a payload-only
 * function.
 *
 * SHA-256 rather than the repository's FNV-1a helpers, matching the worker
 * manifest digest's choice: `contractHash` is compared for compatibility
 * decisions, so a collision would let two different contracts pass for one
 * another, ruling out a cache-key-quality hash.
 *
 * @module core/contract/hash
 */

import { sha256Hex } from '../../worker/manifest/content-digest.ts';
import {
  appendContractRecordField,
  appendSchemaField,
  canonicalMessageContractJson,
} from './normalize.ts';
import type {
  WorkflowActivityContract,
  WorkflowContract,
  WorkflowMessageContract,
} from './types.ts';
import { WORKFLOW_CONTRACT_VERSION } from './types.ts';

/**
 * Algorithm tag prefixed to every digest {@link contractHash} and
 * {@link activityContractHash} produce.
 *
 * @example
 * ```ts
 * import { WORKFLOW_CONTRACT_DIGEST_ALGORITHM } from '@lostgradient/weft';
 *
 * const hash = 'sha256:2b1f0c9d';
 * console.log(hash.startsWith(`${WORKFLOW_CONTRACT_DIGEST_ALGORITHM}:`)); // true
 * ```
 */
export const WORKFLOW_CONTRACT_DIGEST_ALGORITHM = 'sha256';

/**
 * Payload-only canonical serialization: the digest input for
 * {@link contractHash}. Deliberately excludes `name`, `workflowVersion`,
 * `description`, and `tags` — see this module's JSDoc.
 */
function canonicalWorkflowContractPayloadJson(contract: WorkflowContract): string {
  const fields: string[] = [`"contractVersion":${JSON.stringify(WORKFLOW_CONTRACT_VERSION)}`];

  appendSchemaField(fields, 'inputSchema', contract.inputSchema);
  appendSchemaField(fields, 'outputSchema', contract.outputSchema);
  appendContractRecordField(fields, 'signals', contract.signals);
  appendContractRecordField(fields, 'updates', contract.updates);
  appendContractRecordField(fields, 'queries', contract.queries);
  appendContractRecordField(fields, 'activities', contract.activities);
  if (contract.finalizer !== undefined) {
    fields.push(`"finalizer":${canonicalMessageContractJson(contract.finalizer)}`);
  }
  return `{${fields.join(',')}}`;
}

/**
 * Digest canonical contract JSON text.
 *
 * Separate from {@link contractHash} and `deriveWorkflowRevision` so a
 * caller that already holds a canonical serialization does not serialize
 * the contract a second time. Which identity the result represents depends
 * entirely on which canonical serializer produced `canonicalJson` — see this
 * module's JSDoc.
 *
 * @example
 * ```ts
 * import { canonicalWorkflowContractJson, digestCanonicalWorkflowContract } from '@lostgradient/weft';
 *
 * const canonical = canonicalWorkflowContractJson({ name: 'checkout', workflowVersion: '2.1.0' });
 * console.log((await digestCanonicalWorkflowContract(canonical)).startsWith('sha256:'));
 * ```
 */
export async function digestCanonicalWorkflowContract(canonicalJson: string): Promise<string> {
  return sha256Hex(canonicalJson);
}

/**
 * Compute a workflow contract's payload-only content identity.
 *
 * Determined entirely by the payload fields (schemas, signals, updates,
 * queries, activities, finalizer) plus the `WORKFLOW_CONTRACT_VERSION`
 * domain separator — two contracts that differ only in `name`,
 * `workflowVersion`, `description`, or `tags` hash identically, and two
 * contracts that differ only in key order also hash identically.
 *
 * @example
 * ```ts
 * import { contractHash } from '@lostgradient/weft';
 *
 * const left = await contractHash({ name: 'checkout', workflowVersion: '1.0.0' });
 * const right = await contractHash({ name: 'checkout', workflowVersion: '2.0.0' });
 * console.log(left === right); // true — name/workflowVersion are excluded
 * ```
 */
export async function contractHash(contract: WorkflowContract): Promise<string> {
  return digestCanonicalWorkflowContract(canonicalWorkflowContractPayloadJson(contract));
}

/**
 * Compute one activity's payload-only content identity, independent of the
 * workflow contract it is declared under.
 *
 * @example
 * ```ts
 * import { activityContractHash } from '@lostgradient/weft';
 *
 * const hash = await activityContractHash({
 *   inputSchema: { type: 'object', properties: { amount: { type: 'number' } } },
 * });
 * console.log(hash.startsWith('sha256:')); // true
 * ```
 */
export async function activityContractHash(activity: WorkflowActivityContract): Promise<string> {
  const versionField = `"contractVersion":${JSON.stringify(WORKFLOW_CONTRACT_VERSION)}`;
  const schemaFields = canonicalActivityContractSchemaFields(activity);
  return digestCanonicalWorkflowContract(`{${[versionField, ...schemaFields].join(',')}}`);
}

/** Field list (no leading `{`/trailing `}`) for one activity's schema pair, in canonical order. */
function canonicalActivityContractSchemaFields(entry: WorkflowMessageContract): readonly string[] {
  const inner = canonicalMessageContractJson(entry);
  // `canonicalMessageContractJson` returns `{...}` with 0-2 already-comma-joined
  // fields; strip the braces rather than duplicating its field-ordering logic.
  const stripped = inner.slice(1, -1);
  return stripped.length === 0 ? [] : [stripped];
}
