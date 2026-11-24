/**
 * The data types of workflow refresh: the artifact and response a source
 * serves, the options and results of a check, and the diagnostics and status
 * an operator reads.
 *
 * @module core/catalog/workflow-refresh-types
 */

import type { WorkflowRevisionManifest } from '../contract/types.ts';
import type { RegisteredWorkflowDefinition } from '../types/workflow-registry.ts';
import type {
  WorkflowCatalogActivationMode,
  WorkflowCatalogActivationResult,
  WorkflowCatalogActivePointer,
} from './types.ts';
import type { WorkflowCatalog } from './workflow-catalog.ts';
import type { WorkflowRefreshFailureReason } from './workflow-refresh-failure.ts';

export type WorkflowRefreshArtifact = Readonly<{
  manifest: WorkflowRevisionManifest;
  bytes: Uint8Array;
  digest: string;
  identity: Readonly<{ name: string; revision: string }>;
  runtime: string;
}>;

export type WorkflowRefreshResponse = Readonly<{
  status: 200 | 304;
  etag?: string;
  artifact?: WorkflowRefreshArtifact;
}>;

export type WorkflowRefreshDiagnostics = Readonly<{
  name: string;
  state: 'idle' | 'checking' | 'not-modified' | 'warming' | 'activated' | 'installed' | 'failed';
  etag?: string | undefined;
  /** The candidate artifact's revision. */
  revision?: string | undefined;
  /** The candidate artifact's digest. */
  digest?: string | undefined;
  /** The candidate artifact's contract hash. */
  contractHash?: string | undefined;
  generation?: number | undefined;
  checkedAt?: number | undefined;
  /** The host's own message for the last failure. In-process only: it can carry a path or a URL, so never put it on a wire; use `reason`. */
  error?: string | undefined;
  /** Why the last check failed. Absent after a check that did not fail. */
  reason?: WorkflowRefreshFailureReason | undefined;
  /** The revision this coordinator last activated for the name. */
  activatedRevision?: string | undefined;
  /** The digest of the artifact behind {@link activatedRevision}. */
  activatedDigest?: string | undefined;
}>;

/** Polling policy and state while opt-in polling is running. Absent in manual-maintenance mode. */
export type WorkflowRefreshPollingStatus = Readonly<{
  intervalMilliseconds: number;
  maxBackoffMilliseconds: number;
  /** The delay the next failed cycle would wait; equals the interval until a failure. */
  backoffMilliseconds: number;
  /** When the next cycle is due, or `undefined` while a cycle is running. */
  nextCheckAt: number | undefined;
}>;

/** Every registered source (idle until first checked), sorted by name, and the polling state. */
export type WorkflowRefreshStatus = Readonly<{
  sources: readonly WorkflowRefreshDiagnostics[];
  polling: WorkflowRefreshPollingStatus | undefined;
}>;

export type WorkflowRefreshOptions = Readonly<{
  activate?: WorkflowCatalogActivationMode;
  expectedGeneration?: number;
  signal?: AbortSignal;
}>;

export type WorkflowRefreshSource = Readonly<{
  fetch: (request: {
    etag?: string | undefined;
    signal?: AbortSignal | undefined;
  }) => Promise<WorkflowRefreshResponse>;
  warm: (
    artifact: WorkflowRefreshArtifact,
    signal: AbortSignal,
  ) => Promise<RegisteredWorkflowDefinition>;
  validateRuntime: (runtime: string, signal: AbortSignal) => void | Promise<void>;
}>;

export type WorkflowRefreshCoordinatorOptions = Readonly<{
  catalog: WorkflowCatalog;
  sources: ReadonlyMap<string, WorkflowRefreshSource>;
  maxArtifactBytes?: number;
  pollIntervalMs?: number;
  maxBackoffMs?: number;
  now?: () => number;
}>;

export type WorkflowRefreshResult = Readonly<{
  status: 'not-modified' | 'installed' | 'activated';
  etag?: string | undefined;
  manifest?: WorkflowRevisionManifest | undefined;
  pointer?: WorkflowCatalogActivePointer | undefined;
  activation?: WorkflowCatalogActivationResult | undefined;
}>;
