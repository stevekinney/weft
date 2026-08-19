/**
 * Canonical worker manifest and execution-identity vocabulary.
 *
 * This is the single definition of how a worker describes itself and how the
 * host records what actually executed an attempt. The durable task ledger,
 * provenance, routing, workflow versioning, and operator diagnostics all
 * consume these types rather than defining their own.
 *
 * @module worker/manifest
 */

export {
  MAX_MANIFEST_ACTIVITY_COUNT,
  MAX_MANIFEST_CAPABILITY_COUNT,
  MAX_MANIFEST_CAPABILITY_DEPTH,
  MAX_MANIFEST_CAPABILITY_STRING_BYTES,
  MAX_MANIFEST_IDENTIFIER_BYTES,
  MAX_MANIFEST_WORKFLOW_COUNT,
  MAX_NORMALIZED_MANIFEST_BYTES,
} from './limits.ts';

export { WORKER_MANIFEST_VERSION } from './types.ts';
export type {
  WorkerActivityContract,
  WorkerDeploymentIdentity,
  WorkerExecutionIdentity,
  WorkerExecutionRequirement,
  WorkerManifest,
  WorkerRuntimeIdentity,
  WorkerWorkflowContract,
} from './types.ts';

export { canonicalWorkerManifestJson, normalizeWorkerManifest } from './normalize.ts';

export { parseWorkerManifest } from './parse.ts';
export type { WorkerManifestParseResult, WorkerManifestParseSuccess } from './parse.ts';

export { parseWorkerManifestJson } from './parse-json.ts';

export type { ManifestValidationFailure, WorkerManifestRejectionReason } from './failure.ts';

export {
  WORKER_MANIFEST_DIGEST_ALGORITHM,
  computeWorkerManifestDigest,
  digestCanonicalWorkerManifest,
} from './digest.ts';

export { buildWorkerExecutionIdentity, executionIdentitySatisfies } from './execution-identity.ts';
