/**
 * Public promotion of the durable workflow catalog (WFT-9/WFT-10) to
 * `engine.workflows` (WFT-11).
 *
 * This namespace is catalog bookkeeping and promotion control ONLY —
 * `install()`/`activate()` change what {@link import('../registry-snapshot.ts').RegistrySnapshot}
 * reports as the active revision, never which in-process handler
 * `engine.start()` dispatches to. Execution routing resolves purely via
 * `internals.registrations` (the workflow the process actually has code
 * for), a concern dynamic module loading (WFT-13+) will connect to catalog
 * activation. Until then, activating a different installed revision is
 * observable only through this namespace, `getActive()`, and
 * `buildRegistrySnapshot()` — starting a new run of `name` still executes
 * whatever `engine.register()` last registered in this process.
 *
 * A later `engine.register()` call (or the restart-drain path that replays
 * `pendingCatalogInstalls`) can silently revert a manual `activate()` here —
 * `WorkflowCatalog.activateRegistered` is unconditional by design (see its
 * own JSDoc) and does not consult or preserve a prior candidate activation.
 * Reconciling loader-driven and registration-driven activation is WFT-13's
 * job; this namespace does not attempt it.
 *
 * Every method awaits {@link ensureWorkflowCatalogReady} first (skipping the
 * `await` entirely when {@link isWorkflowCatalogReady} already reports warm,
 * matching every other catalog-observing entry point in `index.ts`), so the
 * catalog is always restored from storage and every pending
 * `engine.register()` install is drained before this namespace reads or
 * writes it.
 *
 * @module core/engine/engine-workflows-namespace
 */

import {
  WorkflowRevisionNotInstalledError,
  type WorkflowCatalogActivationResult,
  type WorkflowCatalogActivePointer,
  type WorkflowRevisionRecord,
} from '../catalog/index.ts';
import type { WorkflowCompatibilityPolicy } from '../contract/compatibility.ts';
import type { WorkflowRevisionManifest } from '../contract/types.ts';
import {
  ensureWorkflowCatalogReady,
  getWorkflowCatalog,
  isWorkflowCatalogReady,
} from './catalog-readiness.ts';
import { WorkflowNotRegisteredError } from './errors.ts';
import type { Engine } from './index.ts';

/**
 * Options accepted by {@link EngineWorkflowsNamespace.activate}.
 *
 * @example
 * ```ts
 * import { Engine } from '@lostgradient/weft';
 * import type { ActivateWorkflowRevisionOptions } from '@lostgradient/weft';
 *
 * const engine = new Engine();
 * const active = await engine.workflows.getActive('checkout');
 * const options: ActivateWorkflowRevisionOptions = {
 *   ...(active === null ? {} : { expectedGeneration: active.generation }),
 *   policy: { requireExactRevision: false },
 * };
 * console.log(options.expectedGeneration);
 * ```
 */
export type ActivateWorkflowRevisionOptions = {
  /**
   * The generation this caller last observed. Required once `name` has an
   * active pointer — an omitted value there refuses with
   * `expected-generation-required` rather than silently activating, which
   * is what prevents two refreshers from racing to last-write-win. Omit (or
   * pass `0`) for the very first activation of a name, which has no prior
   * generation to name.
   */
  expectedGeneration?: number;
  /** Compatibility policy; defaults to `DEFAULT_WORKFLOW_COMPATIBILITY_POLICY`. */
  policy?: WorkflowCompatibilityPolicy;
};

/**
 * Admin-facing surface over the durable workflow catalog: install a
 * revision's manifest, activate an installed revision as the advertised
 * active one, and read back installed/active state. Workflow code never
 * touches this — it is an external maintenance and deployment-tooling
 * surface, the same audience `engine.state.*` serves.
 *
 * @example
 * ```ts
 * import { Engine, buildWorkflowContract, buildWorkflowRevisionManifest } from '@lostgradient/weft';
 * import { workflow, type WorkflowContext } from '@lostgradient/weft';
 * import type { EngineWorkflowsNamespace } from '@lostgradient/weft';
 *
 * const checkout = workflow({ name: 'checkout', version: '1.0.0' }).execute(
 *   async function* (_ctx: WorkflowContext, input: string) {
 *     return input;
 *   },
 * );
 *
 * const engine = new Engine();
 * engine.register(checkout);
 * const workflows: EngineWorkflowsNamespace = engine.workflows;
 *
 * const contract = buildWorkflowContract({ name: 'checkout', version: '1.0.0' });
 * const manifest = await buildWorkflowRevisionManifest(contract);
 * const record = await workflows.install(manifest);
 * const result = await workflows.activate('checkout', record.manifest.revision);
 * console.log(result.applied);
 * ```
 */
export interface EngineWorkflowsNamespace {
  /**
   * Install `manifest` for durable tracking. Requires
   * `engine.getWorkflowDefinition(manifest.name)` to already resolve
   * in-process — this namespace installs bookkeeping for a definition the
   * engine already has, it does not load one (that is WFT-13+'s job).
   * Idempotent on a byte-identical reinstall; throws
   * {@link WorkflowCatalogConflictError} when `(manifest.name, manifest.revision)`
   * is already installed with different contract content, and
   * {@link WorkflowNotRegisteredError} when no in-process definition exists.
   */
  install(manifest: WorkflowRevisionManifest): Promise<WorkflowRevisionRecord>;
  /**
   * Activate an already-installed `(name, revision)` as the durably
   * advertised active revision. Throws
   * {@link WorkflowRevisionNotInstalledError} when that revision was never
   * installed; otherwise delegates to the catalog's guarded
   * `activateCandidate` and returns its structured result verbatim,
   * including every `applied: false` refusal variant.
   */
  activate(
    name: string,
    revision: string,
    options?: ActivateWorkflowRevisionOptions,
  ): Promise<WorkflowCatalogActivationResult>;
  /**
   * The current active pointer for `name`, or `null` when never activated.
   * In-memory only, matching {@link import('../registry-snapshot.ts').RegistrySnapshot}'s
   * `activeRevisions` staleness contract exactly — the property that makes
   * "operations and the registry snapshot agree" true by construction.
   */
  getActive(name: string): Promise<WorkflowCatalogActivePointer | null>;
  /** One installed `(name, revision)` record, or `null` when not installed. */
  getRevision(name: string, revision: string): Promise<WorkflowRevisionRecord | null>;
  /** Every installed revision of `name`, sorted deterministically by revision. */
  listRevisions(name: string): Promise<readonly WorkflowRevisionRecord[]>;
}

async function ensureCatalogReady(engine: Engine): Promise<void> {
  if (!isWorkflowCatalogReady(engine)) {
    await ensureWorkflowCatalogReady(engine);
  }
}

async function installWorkflowRevision(
  engine: Engine,
  manifest: WorkflowRevisionManifest,
): Promise<WorkflowRevisionRecord> {
  await ensureCatalogReady(engine);
  if (engine.getWorkflowDefinition(manifest.name) === undefined) {
    throw new WorkflowNotRegisteredError(manifest.name);
  }
  const entry = await getWorkflowCatalog(engine).install(manifest);
  return { manifest: entry.manifest, installedAt: entry.installedAt };
}

async function activateWorkflowRevision(
  engine: Engine,
  name: string,
  revision: string,
  options?: ActivateWorkflowRevisionOptions,
): Promise<WorkflowCatalogActivationResult> {
  await ensureCatalogReady(engine);
  const catalog = getWorkflowCatalog(engine);
  const entry = await catalog.resolveEntry(name, revision);
  if (entry === undefined) {
    throw new WorkflowRevisionNotInstalledError(name, revision);
  }
  return catalog.activateCandidate(name, entry.manifest, options);
}

async function getActiveWorkflowRevision(
  engine: Engine,
  name: string,
): Promise<WorkflowCatalogActivePointer | null> {
  await ensureCatalogReady(engine);
  return getWorkflowCatalog(engine).resolveActive(name) ?? null;
}

async function getInstalledWorkflowRevision(
  engine: Engine,
  name: string,
  revision: string,
): Promise<WorkflowRevisionRecord | null> {
  await ensureCatalogReady(engine);
  const entry = await getWorkflowCatalog(engine).resolveEntry(name, revision);
  return entry ?? null;
}

async function listInstalledWorkflowRevisions(
  engine: Engine,
  name: string,
): Promise<readonly WorkflowRevisionRecord[]> {
  await ensureCatalogReady(engine);
  return getWorkflowCatalog(engine).listInstalledRevisions(name);
}

/** Build the `engine.workflows` namespace object for `engine`. */
export function createEngineWorkflowsNamespace(engine: Engine): EngineWorkflowsNamespace {
  return {
    install: (manifest) => installWorkflowRevision(engine, manifest),
    activate: (name, revision, options) =>
      activateWorkflowRevision(engine, name, revision, options),
    getActive: (name) => getActiveWorkflowRevision(engine, name),
    getRevision: (name, revision) => getInstalledWorkflowRevision(engine, name, revision),
    listRevisions: (name) => listInstalledWorkflowRevisions(engine, name),
  };
}
