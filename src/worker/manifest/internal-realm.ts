/**
 * Manifest builder shared by both sides of the internal Worker realm
 * handshake (WFT-28).
 *
 * Unlike the RemoteWorker SDK, an internal `workflowExecutionMode: 'worker'`
 * realm has no per-workflow activity list or version metadata to report —
 * workflow generators are opaque functions, not a declared activity table —
 * so this builder only asserts the one thing both sides can honestly derive:
 * the identity of a registered workflow *type name*. `workflowVersion` is
 * the uniform {@link DEFAULT_WORKFLOW_VERSION} placeholder rather than each
 * definition's real declared version, so the host and the realm never need
 * to keep a second copy of version metadata in sync (the exact class of
 * drift this handshake exists to catch elsewhere). Real per-workflow
 * contract generation is WFT-29 scope, same as the RemoteWorker SDK's
 * `declared-shape:` placeholders.
 *
 * The host validates that every workflow type it has registered is present
 * in the realm's manifest with a matching contract — a *subset* check, not
 * exact-set equality. A realm bootstrap script legitimately advertises more
 * workflow types than any one host process dispatches (a shared worker pool
 * serving several engines, each using a different slice of it); what must
 * never happen is the host dispatching to a realm that is missing a type it
 * expects. {@link declaredWorkflowContractsMatch} is what the host compares
 * per expected type; {@link buildInternalRealmManifest} is what the realm
 * uses to build its own full advertised manifest.
 *
 * `runtime` is a fixed constant rather than `detectRuntime()`: a browser Web
 * Worker has no `window`/`document` in its own scope, so it detects as
 * `'edge'` while the hosting page detects as `'browser'` — real detection
 * would make otherwise-identical manifests diverge on every browser
 * deployment. Both sides call this same function, so a constant is exactly
 * as comparable and avoids that divergence entirely.
 *
 * @module worker/manifest/internal-realm
 */

import { DEFAULT_WORKFLOW_VERSION } from '../../core/versioning.ts';
import { WORKER_PROTOCOL_VERSION } from '../../core/worker-protocol.ts';
import { VERSION } from '../../version.ts';
import { declaredShapeDigest } from './declared-shape-digest.ts';
import {
  WORKER_MANIFEST_VERSION,
  type WorkerManifest,
  type WorkerWorkflowContract,
} from './index.ts';

/** Fixed deployment name for every internal Worker realm manifest. */
export const INTERNAL_WORKER_REALM_DEPLOYMENT_NAME = 'internal-worker-realm';

/** Fixed runtime identity reported by every internal Worker realm manifest. See {@link buildInternalRealmManifest}. */
export const INTERNAL_WORKER_REALM_RUNTIME_NAME = 'internal-worker-realm';

/** Pure function of `workflowType` alone — identical on the host and the realm for the same name. */
export function buildDeclaredWorkflowContract(workflowType: string): WorkerWorkflowContract {
  const digest = declaredShapeDigest(workflowType);
  return {
    workflowVersion: DEFAULT_WORKFLOW_VERSION,
    workflowRevision: digest,
    contractHash: digest,
    activities: {},
  };
}

/** Whether a realm-reported contract for one workflow type matches what the host expects for that same type name. */
export function declaredWorkflowContractsMatch(
  reported: WorkerWorkflowContract,
  expected: WorkerWorkflowContract,
): boolean {
  return (
    reported.workflowVersion === expected.workflowVersion &&
    reported.workflowRevision === expected.workflowRevision &&
    reported.contractHash === expected.contractHash &&
    Object.keys(reported.activities).length === 0 &&
    Object.keys(expected.activities).length === 0
  );
}

/**
 * Build the manifest an internal Worker realm advertises, or the manifest
 * the engine host expects a realm to advertise — the same function computes
 * both sides so an honest mismatch is the only way the digests can differ.
 */
export function buildInternalRealmManifest(workflowTypes: readonly string[]): WorkerManifest {
  const sortedTypes = [...workflowTypes].toSorted();
  const workflows: Record<string, WorkerWorkflowContract> = {};
  for (const workflowType of sortedTypes) {
    workflows[workflowType] = buildDeclaredWorkflowContract(workflowType);
  }
  const artifactDigest = declaredShapeDigest(sortedTypes.join(','));

  return {
    manifestVersion: WORKER_MANIFEST_VERSION,
    protocolVersion: WORKER_PROTOCOL_VERSION,
    sdkVersion: VERSION,
    runtime: { name: INTERNAL_WORKER_REALM_RUNTIME_NAME, version: VERSION },
    deployment: {
      name: INTERNAL_WORKER_REALM_DEPLOYMENT_NAME,
      buildId: artifactDigest,
      artifactDigest,
    },
    workflows,
    capabilities: {},
  };
}
