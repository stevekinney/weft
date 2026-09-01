/**
 * Canonical, normalized workflow contract vocabulary — the single input to
 * both TypeScript code generation and `contractHash()`, plus the typed
 * `WorkflowRevisionManifest` and its hostile-input parser.
 *
 * @module core/contract
 */

export {
  MAX_CONTRACT_IDENTIFIER_BYTES,
  MAX_CONTRACT_MESSAGE_COUNT,
  MAX_CONTRACT_SCHEMA_DEPTH,
  MAX_NORMALIZED_CONTRACT_BYTES,
} from './limits.ts';

export { WORKFLOW_CONTRACT_VERSION, WORKFLOW_REVISION_MANIFEST_VERSION } from './types.ts';
export type {
  WorkflowActivityContract,
  WorkflowContract,
  WorkflowContractActivitySource,
  WorkflowContractMessageSource,
  WorkflowContractSource,
  WorkflowMessageContract,
  WorkflowRevisionManifest,
} from './types.ts';

export { WorkflowContractConversionError, buildWorkflowContract } from './build.ts';

export { canonicalWorkflowContractJson, normalizeWorkflowContract } from './normalize.ts';

export {
  WORKFLOW_CONTRACT_DIGEST_ALGORITHM,
  activityContractHash,
  contractHash,
  digestCanonicalWorkflowContract,
} from './hash.ts';

export { deriveWorkflowRevision } from './revision.ts';

export { buildWorkflowRevisionManifest } from './manifest.ts';
export type { BuildWorkflowRevisionManifestOptions } from './manifest.ts';

export type {
  WorkflowRevisionManifestRejectionReason,
  WorkflowRevisionManifestValidationFailure,
} from './failure.ts';

export { parseWorkflowRevisionManifest } from './manifest-parse.ts';
export type {
  WorkflowRevisionManifestParseResult,
  WorkflowRevisionManifestParseSuccess,
} from './manifest-parse.ts';
