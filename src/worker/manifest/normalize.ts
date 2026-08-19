/**
 * Deterministic normalization and canonical serialization for worker
 * manifests.
 *
 * Two manifests that describe the same worker must produce byte-identical
 * canonical output regardless of how their object keys were ordered in the
 * source, so the digest identifies the *content* rather than an accident of
 * construction. Serialization walks the declared manifest shape explicitly
 * instead of generically stringifying the input, which means an unknown extra
 * property can never leak into the canonical bytes and change a digest.
 *
 * @module worker/manifest/normalize
 */

import type { JSONValue } from '../../core/json.ts';
import type { WorkerActivityContract, WorkerManifest, WorkerWorkflowContract } from './types.ts';

/**
 * Sort record keys by UTF-16 code unit, the same comparator the registry
 * snapshot uses, so manifest ordering matches the rest of the codebase.
 */
function sortedKeys(record: Readonly<Record<string, unknown>>): readonly string[] {
  return Object.keys(record).toSorted();
}

/**
 * Rebuild a record with sorted keys on a null prototype.
 *
 * The null prototype is what lets a workflow or activity literally named
 * `__proto__` survive normalization as an ordinary entry — the same technique
 * `buildRegistrySnapshot()` relies on.
 */
function sortedRecord<In, Out>(
  record: Readonly<Record<string, In>>,
  normalizeValue: (value: In) => Out,
): Readonly<Record<string, Out>> {
  const normalized: Record<string, Out> = Object.create(null) as Record<string, Out>;
  for (const key of sortedKeys(record)) {
    normalized[key] = normalizeValue(record[key] as In);
  }
  return normalized;
}

/**
 * Recursively rebuild a `JSONValue` so no array or object inside it is
 * shared with the caller-owned input.
 *
 * Without this, a capability array or nested object survives normalization
 * by reference: mutating the caller's original value after a successful
 * parse would then change `result.manifest` while `result.canonicalJson` and
 * any digest computed from it still describe the pre-mutation content,
 * letting stored manifest data and its asserted identity diverge.
 */
function cloneJsonValue(value: JSONValue): JSONValue {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((entry) => cloneJsonValue(entry));

  const record = value as { readonly [key: string]: JSONValue };
  const cloned: Record<string, JSONValue> = Object.create(null) as Record<string, JSONValue>;
  for (const key of Object.keys(record)) {
    cloned[key] = cloneJsonValue(record[key] as JSONValue);
  }
  return cloned;
}

function normalizeActivity(activity: WorkerActivityContract): WorkerActivityContract {
  return {
    contractHash: activity.contractHash,
    implementationRevision: activity.implementationRevision,
  };
}

function normalizeWorkflow(workflow: WorkerWorkflowContract): WorkerWorkflowContract {
  return {
    workflowVersion: workflow.workflowVersion,
    workflowRevision: workflow.workflowRevision,
    contractHash: workflow.contractHash,
    activities: sortedRecord(workflow.activities, normalizeActivity),
  };
}

/**
 * Normalize a manifest into its canonical in-memory form.
 *
 * Field order follows the declared shape and every open-ended record is
 * rebuilt with its keys sorted. The result is a fresh value; the input is not
 * mutated.
 *
 * @example
 * ```ts
 * import { normalizeWorkerManifest, WORKER_MANIFEST_VERSION } from '@lostgradient/weft';
 *
 * const normalized = normalizeWorkerManifest({
 *   manifestVersion: WORKER_MANIFEST_VERSION,
 *   protocolVersion: 2,
 *   sdkVersion: '0.18.0',
 *   runtime: { name: 'bun', version: '1.3.14' },
 *   deployment: { name: 'billing', buildId: 'b3', artifactDigest: 'sha256:41d0' },
 *   workflows: {},
 *   capabilities: { zeta: 1, alpha: 2 },
 * });
 * console.log(Object.keys(normalized.capabilities)); // ['alpha', 'zeta']
 * ```
 */
export function normalizeWorkerManifest(manifest: WorkerManifest): WorkerManifest {
  return {
    manifestVersion: manifest.manifestVersion,
    protocolVersion: manifest.protocolVersion,
    sdkVersion: manifest.sdkVersion,
    runtime: { name: manifest.runtime.name, version: manifest.runtime.version },
    deployment: {
      name: manifest.deployment.name,
      buildId: manifest.deployment.buildId,
      artifactDigest: manifest.deployment.artifactDigest,
    },
    workflows: sortedRecord(manifest.workflows, normalizeWorkflow),
    capabilities: sortedRecord(manifest.capabilities, cloneJsonValue),
  };
}

// ---------------------------------------------------------------------------
// Canonical serialization
// ---------------------------------------------------------------------------

/**
 * Serialize an arbitrary JSON value with object keys sorted at every depth.
 *
 * Only reached for `capabilities` values, which are open-ended by design. The
 * manifest parser has already proven the value is a bounded `JSONValue`, so
 * there is no cycle or `undefined` case left to handle here.
 */
function canonicalJsonValue(value: JSONValue): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);

  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJsonValue(entry)).join(',')}]`;
  }

  const record = value as { readonly [key: string]: JSONValue };
  const entries = sortedKeys(record).map(
    (key) => `${JSON.stringify(key)}:${canonicalJsonValue(record[key] as JSONValue)}`,
  );
  return `{${entries.join(',')}}`;
}

function canonicalActivityJson(activity: WorkerActivityContract): string {
  return `{"contractHash":${JSON.stringify(activity.contractHash)},"implementationRevision":${JSON.stringify(activity.implementationRevision)}}`;
}

function canonicalWorkflowJson(workflow: WorkerWorkflowContract): string {
  const activities = sortedKeys(workflow.activities)
    .map(
      (name) =>
        `${JSON.stringify(name)}:${canonicalActivityJson(workflow.activities[name] as WorkerActivityContract)}`,
    )
    .join(',');

  return [
    `{"workflowVersion":${JSON.stringify(workflow.workflowVersion)}`,
    `"workflowRevision":${JSON.stringify(workflow.workflowRevision)}`,
    `"contractHash":${JSON.stringify(workflow.contractHash)}`,
    `"activities":{${activities}}}`,
  ].join(',');
}

/**
 * Serialize a manifest to its canonical JSON string.
 *
 * The output is the digest input: byte-identical for equivalent manifests and
 * different for any manifest that differs in a field the host cares about.
 *
 * @example
 * ```ts
 * import { canonicalWorkerManifestJson, WORKER_MANIFEST_VERSION } from '@lostgradient/weft';
 *
 * const base = {
 *   manifestVersion: WORKER_MANIFEST_VERSION,
 *   protocolVersion: 2,
 *   sdkVersion: '0.18.0',
 *   runtime: { name: 'bun', version: '1.3.14' },
 *   deployment: { name: 'billing', buildId: 'b3', artifactDigest: 'sha256:41d0' },
 *   workflows: {},
 * } as const;
 *
 * const left = canonicalWorkerManifestJson({ ...base, capabilities: { a: 1, b: 2 } });
 * const right = canonicalWorkerManifestJson({ ...base, capabilities: { b: 2, a: 1 } });
 * console.log(left === right); // true
 * ```
 */
export function canonicalWorkerManifestJson(manifest: WorkerManifest): string {
  const workflows = sortedKeys(manifest.workflows)
    .map(
      (name) =>
        `${JSON.stringify(name)}:${canonicalWorkflowJson(manifest.workflows[name] as WorkerWorkflowContract)}`,
    )
    .join(',');

  const capabilities = sortedKeys(manifest.capabilities)
    .map(
      (key) =>
        `${JSON.stringify(key)}:${canonicalJsonValue(manifest.capabilities[key] as JSONValue)}`,
    )
    .join(',');

  return [
    `{"manifestVersion":${JSON.stringify(manifest.manifestVersion)}`,
    `"protocolVersion":${JSON.stringify(manifest.protocolVersion)}`,
    `"sdkVersion":${JSON.stringify(manifest.sdkVersion)}`,
    `"runtime":{"name":${JSON.stringify(manifest.runtime.name)},"version":${JSON.stringify(manifest.runtime.version)}}`,
    `"deployment":{"name":${JSON.stringify(manifest.deployment.name)},"buildId":${JSON.stringify(manifest.deployment.buildId)},"artifactDigest":${JSON.stringify(manifest.deployment.artifactDigest)}}`,
    `"workflows":{${workflows}}`,
    `"capabilities":{${capabilities}}}`,
  ].join(',');
}
