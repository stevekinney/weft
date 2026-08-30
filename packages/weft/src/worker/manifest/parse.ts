/**
 * Hostile-input parsing for worker manifests.
 *
 * Everything here treats its input as adversarial: a manifest arrives from a
 * worker process the host does not control, and it decides whether that worker
 * becomes routing-eligible. Every field is proven from `unknown` rather than
 * asserted, every open-ended collection is bounded before it is walked, and
 * the normalized size is checked against the canonical form so a compact
 * payload cannot expand past the ceiling after normalization.
 *
 * @module worker/manifest/parse
 */

import { validateWorkflowOrActivityName, type NameKind } from '../../core/types/name-grammar.ts';
import { parseManifestCapabilities } from './capabilities.ts';
import { manifestFailure, type ManifestValidationFailure } from './failure.ts';
import { isRecord } from './is-record.ts';
import {
  MAX_MANIFEST_ACTIVITY_COUNT,
  MAX_MANIFEST_IDENTIFIER_BYTES,
  MAX_MANIFEST_WORKFLOW_COUNT,
  MAX_NORMALIZED_MANIFEST_BYTES,
} from './limits.ts';
import { canonicalWorkerManifestJson, normalizeWorkerManifest } from './normalize.ts';
import type {
  WorkerActivityContract,
  WorkerDeploymentIdentity,
  WorkerManifest,
  WorkerRuntimeIdentity,
  WorkerWorkflowContract,
} from './types.ts';
import { WORKER_MANIFEST_VERSION } from './types.ts';
import { utf8ByteLength } from './utf8.ts';

/**
 * A successfully validated manifest, paired with the canonical serialization
 * the digest is computed over so callers do not serialize it a second time.
 *
 * @example
 * ```ts
 * import {
 *   digestCanonicalWorkerManifest,
 *   parseWorkerManifest,
 *   type WorkerManifestParseSuccess,
 * } from '@lostgradient/weft';
 *
 * const result = parseWorkerManifest({
 *   manifestVersion: 1,
 *   protocolVersion: 2,
 *   sdkVersion: '0.18.0',
 *   runtime: { name: 'bun', version: '1.3.14' },
 *   deployment: { name: 'billing', buildId: 'b3', artifactDigest: 'sha256:41d0' },
 *   workflows: {},
 *   capabilities: {},
 * });
 *
 * if (result.ok) {
 *   const accepted: WorkerManifestParseSuccess = result;
 *   console.log(await digestCanonicalWorkerManifest(accepted.canonicalJson));
 * }
 * ```
 */
export type WorkerManifestParseSuccess = Readonly<{
  ok: true;
  /** The normalized manifest, with every open-ended record key sorted. */
  manifest: WorkerManifest;
  /** Canonical serialization of that manifest — the digest input. */
  canonicalJson: string;
}>;

/**
 * Outcome of validating an untrusted manifest.
 *
 * @example
 * ```ts
 * import { parseWorkerManifest, type WorkerManifestParseResult } from '@lostgradient/weft';
 *
 * const result: WorkerManifestParseResult = parseWorkerManifest({});
 * console.log(result.ok);
 * ```
 */
export type WorkerManifestParseResult = WorkerManifestParseSuccess | ManifestValidationFailure;

/**
 * Validate one identifier-shaped string: present, non-empty, and within the
 * shared byte ceiling.
 */
function parseIdentifier(
  value: unknown,
  path: string,
): { ok: true; value: string } | ManifestValidationFailure {
  if (typeof value !== 'string' || value.length === 0) {
    return manifestFailure('invalid_field', 'must be a non-empty string', path);
  }

  const bytes = utf8ByteLength(value);
  if (bytes > MAX_MANIFEST_IDENTIFIER_BYTES) {
    return manifestFailure(
      'identifier_too_long',
      `is ${bytes} bytes, exceeding the maximum identifier size of ${MAX_MANIFEST_IDENTIFIER_BYTES}`,
      path,
    );
  }

  return { ok: true, value };
}

/**
 * Validate a record key with the same ceiling as the values it addresses.
 *
 * Workflow and activity names become storage-key components and diagnostic
 * labels downstream, so an unbounded key is as dangerous as an unbounded
 * value.
 */
function checkKey(
  key: string,
  kind: NameKind,
  path: string,
): ManifestValidationFailure | undefined {
  if (key.length === 0) {
    return manifestFailure('invalid_field', 'must not be an empty string', path);
  }

  const bytes = utf8ByteLength(key);
  if (bytes > MAX_MANIFEST_IDENTIFIER_BYTES) {
    return manifestFailure(
      'identifier_too_long',
      `is ${bytes} bytes, exceeding the maximum identifier size of ${MAX_MANIFEST_IDENTIFIER_BYTES}`,
      path,
    );
  }

  try {
    validateWorkflowOrActivityName(key, kind);
  } catch (error) {
    return manifestFailure(
      'invalid_field',
      error instanceof Error ? error.message : 'is not a wire-safe name',
      path,
    );
  }

  return undefined;
}

function parseProtocolVersion(
  value: unknown,
): { ok: true; value: number } | ManifestValidationFailure {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    return manifestFailure(
      'invalid_field',
      'must be a positive safe integer',
      'manifest.protocolVersion',
    );
  }
  return { ok: true, value };
}

function parseRuntime(
  value: unknown,
  path: string,
): { ok: true; runtime: WorkerRuntimeIdentity } | ManifestValidationFailure {
  if (!isRecord(value)) {
    return manifestFailure('invalid_field', 'must be a JSON object', path);
  }

  const name = parseIdentifier(value['name'], `${path}.name`);
  if (!name.ok) return name;

  // A browser or edge runtime exposes no version, so an empty string is a
  // truthful answer here rather than a missing field.
  const rawVersion = value['version'];
  if (typeof rawVersion !== 'string') {
    return manifestFailure('invalid_field', 'must be a string', `${path}.version`);
  }
  const versionBytes = utf8ByteLength(rawVersion);
  if (versionBytes > MAX_MANIFEST_IDENTIFIER_BYTES) {
    return manifestFailure(
      'identifier_too_long',
      `is ${versionBytes} bytes, exceeding the maximum identifier size of ${MAX_MANIFEST_IDENTIFIER_BYTES}`,
      `${path}.version`,
    );
  }

  return { ok: true, runtime: { name: name.value, version: rawVersion } };
}

function parseDeployment(
  value: unknown,
  path: string,
): { ok: true; deployment: WorkerDeploymentIdentity } | ManifestValidationFailure {
  if (!isRecord(value)) {
    return manifestFailure('invalid_field', 'must be a JSON object', path);
  }

  const name = parseIdentifier(value['name'], `${path}.name`);
  if (!name.ok) return name;
  const buildId = parseIdentifier(value['buildId'], `${path}.buildId`);
  if (!buildId.ok) return buildId;
  const artifactDigest = parseIdentifier(value['artifactDigest'], `${path}.artifactDigest`);
  if (!artifactDigest.ok) return artifactDigest;

  return {
    ok: true,
    deployment: {
      name: name.value,
      buildId: buildId.value,
      artifactDigest: artifactDigest.value,
    },
  };
}

function parseActivity(
  value: unknown,
  path: string,
): { ok: true; activity: WorkerActivityContract } | ManifestValidationFailure {
  if (!isRecord(value)) {
    return manifestFailure('invalid_field', 'must be a JSON object', path);
  }

  const contractHash = parseIdentifier(value['contractHash'], `${path}.contractHash`);
  if (!contractHash.ok) return contractHash;
  const implementationRevision = parseIdentifier(
    value['implementationRevision'],
    `${path}.implementationRevision`,
  );
  if (!implementationRevision.ok) return implementationRevision;

  return {
    ok: true,
    activity: {
      contractHash: contractHash.value,
      implementationRevision: implementationRevision.value,
    },
  };
}

function parseActivities(
  value: unknown,
  path: string,
): { ok: true; activities: Record<string, WorkerActivityContract> } | ManifestValidationFailure {
  if (!isRecord(value)) {
    return manifestFailure('invalid_field', 'must be a JSON object', path);
  }

  const names = Object.keys(value);
  if (names.length > MAX_MANIFEST_ACTIVITY_COUNT) {
    return manifestFailure(
      'too_many_activities',
      `declares ${names.length} activities, exceeding the maximum of ${MAX_MANIFEST_ACTIVITY_COUNT}`,
      path,
    );
  }

  const activities: Record<string, WorkerActivityContract> = Object.create(null) as Record<
    string,
    WorkerActivityContract
  >;
  for (const name of names) {
    const keyFailure = checkKey(name, 'activity', `${path} key ${JSON.stringify(name)}`);
    if (keyFailure !== undefined) return keyFailure;

    const activity = parseActivity(value[name], `${path}.${name}`);
    if (!activity.ok) return activity;
    activities[name] = activity.activity;
  }

  return { ok: true, activities };
}

function parseWorkflow(
  value: unknown,
  path: string,
): { ok: true; workflow: WorkerWorkflowContract } | ManifestValidationFailure {
  if (!isRecord(value)) {
    return manifestFailure('invalid_field', 'must be a JSON object', path);
  }

  const workflowVersion = parseIdentifier(value['workflowVersion'], `${path}.workflowVersion`);
  if (!workflowVersion.ok) return workflowVersion;
  const workflowRevision = parseIdentifier(value['workflowRevision'], `${path}.workflowRevision`);
  if (!workflowRevision.ok) return workflowRevision;
  const contractHash = parseIdentifier(value['contractHash'], `${path}.contractHash`);
  if (!contractHash.ok) return contractHash;

  const activities = parseActivities(value['activities'], `${path}.activities`);
  if (!activities.ok) return activities;

  return {
    ok: true,
    workflow: {
      workflowVersion: workflowVersion.value,
      workflowRevision: workflowRevision.value,
      contractHash: contractHash.value,
      activities: activities.activities,
    },
  };
}

function parseWorkflows(
  value: unknown,
  path: string,
): { ok: true; workflows: Record<string, WorkerWorkflowContract> } | ManifestValidationFailure {
  if (!isRecord(value)) {
    return manifestFailure('invalid_field', 'must be a JSON object', path);
  }

  const names = Object.keys(value);
  if (names.length > MAX_MANIFEST_WORKFLOW_COUNT) {
    return manifestFailure(
      'too_many_workflows',
      `declares ${names.length} workflows, exceeding the maximum of ${MAX_MANIFEST_WORKFLOW_COUNT}`,
      path,
    );
  }

  const workflows: Record<string, WorkerWorkflowContract> = Object.create(null) as Record<
    string,
    WorkerWorkflowContract
  >;
  for (const name of names) {
    const keyFailure = checkKey(name, 'workflow', `${path} key ${JSON.stringify(name)}`);
    if (keyFailure !== undefined) return keyFailure;

    const workflow = parseWorkflow(value[name], `${path}.${name}`);
    if (!workflow.ok) return workflow;
    workflows[name] = workflow.workflow;
  }

  return { ok: true, workflows };
}

/**
 * Validate an untrusted worker manifest.
 *
 * The returned manifest is already normalized, so a caller that stores or
 * digests the result never has to re-derive canonical form. Rejection is a
 * value, not an exception — a bad manifest is an ordinary wire condition.
 *
 * @example
 * ```ts
 * import { parseWorkerManifest } from '@lostgradient/weft';
 *
 * const result = parseWorkerManifest({
 *   manifestVersion: 1,
 *   protocolVersion: 2,
 *   sdkVersion: '0.18.0',
 *   runtime: { name: 'bun', version: '1.3.14' },
 *   deployment: { name: 'billing', buildId: 'b3', artifactDigest: 'sha256:41d0' },
 *   workflows: {},
 *   capabilities: {},
 * });
 *
 * console.log(result.ok ? result.manifest.deployment.name : result.reason);
 * ```
 */
export function parseWorkerManifest(value: unknown): WorkerManifestParseResult {
  if (!isRecord(value)) {
    return manifestFailure('not_an_object', 'manifest must be a JSON object');
  }

  // Version is checked before any other field so an unknown schema is rejected
  // rather than best-effort parsed against the shape we happen to know.
  if (value['manifestVersion'] !== WORKER_MANIFEST_VERSION) {
    return manifestFailure(
      'unsupported_manifest_version',
      `manifest.manifestVersion must be ${String(WORKER_MANIFEST_VERSION)}`,
    );
  }

  const protocolVersion = parseProtocolVersion(value['protocolVersion']);
  if (!protocolVersion.ok) return protocolVersion;

  const sdkVersion = parseIdentifier(value['sdkVersion'], 'manifest.sdkVersion');
  if (!sdkVersion.ok) return sdkVersion;

  const runtime = parseRuntime(value['runtime'], 'manifest.runtime');
  if (!runtime.ok) return runtime;

  const deployment = parseDeployment(value['deployment'], 'manifest.deployment');
  if (!deployment.ok) return deployment;

  const workflows = parseWorkflows(value['workflows'], 'manifest.workflows');
  if (!workflows.ok) return workflows;

  const capabilities = parseManifestCapabilities(value['capabilities'], 'manifest.capabilities');
  if (!capabilities.ok) return capabilities;

  // Every field above was rebuilt from proven parts, so nothing unknown can
  // survive into the manifest. Normalizing once more sorts the open-ended
  // records, which makes the returned value byte-equivalent to the canonical
  // form callers will store and diff.
  const manifest = normalizeWorkerManifest({
    manifestVersion: WORKER_MANIFEST_VERSION,
    protocolVersion: protocolVersion.value,
    sdkVersion: sdkVersion.value,
    runtime: runtime.runtime,
    deployment: deployment.deployment,
    workflows: workflows.workflows,
    capabilities: capabilities.capabilities,
  });

  const canonicalJson = canonicalWorkerManifestJson(manifest);
  const canonicalBytes = utf8ByteLength(canonicalJson);
  if (canonicalBytes > MAX_NORMALIZED_MANIFEST_BYTES) {
    return manifestFailure(
      'manifest_too_large',
      `normalizes to ${canonicalBytes} bytes, exceeding the maximum of ${MAX_NORMALIZED_MANIFEST_BYTES}`,
      'manifest',
    );
  }

  return { ok: true, manifest, canonicalJson };
}
