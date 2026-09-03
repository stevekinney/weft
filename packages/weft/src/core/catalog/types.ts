/**
 * In-memory and wire types for the durable workflow catalog (WFT-9/WFT-10).
 *
 * `WorkflowCatalog` keys entries with nested `Map<string, Map<string, ...>>`
 * structures — never delimiter-joined strings — so a workflow `name` or
 * `revision` equal to `'__proto__'`, `'toString'`, or containing a colon is
 * always safe to store and look up.
 *
 * @module core/catalog/types
 */

import type { WorkflowCompatibilityVerdict } from '../contract/compatibility.ts';
import type { WorkflowRevisionManifest } from '../contract/types.ts';
import type { RegisteredWorkflowDefinition } from '../types/workflow-registry.ts';

/**
 * One installed `(name, revision)` catalog entry. `definition` is populated
 * only when this process itself installed the entry (via
 * `engine.register()`'s drain path) — an entry hydrated from durable storage
 * at boot, for a revision this process has not (yet) registered, carries no
 * live `definition` because a `RegisteredWorkflowDefinition` cannot be
 * persisted (it holds function references). Consumers that only need
 * identity (`resolveActive`, registry-snapshot's `activeRevisions`) never
 * touch `definition`.
 */
export type WorkflowCatalogEntry = Readonly<{
  manifest: WorkflowRevisionManifest;
  definition?: RegisteredWorkflowDefinition;
  installedAt: number;
}>;

/** The durable `{ revision, generation, activatedAt }` pointer for one workflow name. */
export type WorkflowCatalogActivePointer = Readonly<{
  revision: string;
  generation: number;
  activatedAt: number;
}>;

/**
 * Result of {@link import('./workflow-catalog.ts').WorkflowCatalog.activateCandidate}.
 * A candidate either applies (bumping the durable generation) or is refused
 * with a specific, machine-readable reason — never silently ignored.
 */
export type WorkflowCatalogActivationResult =
  | Readonly<{ applied: true; pointer: WorkflowCatalogActivePointer }>
  | Readonly<{ applied: false; reason: 'incompatible'; verdict: WorkflowCompatibilityVerdict }>
  | Readonly<{ applied: false; reason: 'stale-generation'; currentGeneration: number }>
  | Readonly<{ applied: false; reason: 'conflict' }>;
