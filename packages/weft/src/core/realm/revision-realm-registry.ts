/**
 * `Map<name, Map<revision, RevisionRealmPool>>` — the coordinator-level
 * surface COR-249 asks for: one {@link RevisionRealmPool} per immutable
 * `(name, revision)`, never one Worker shared across unrelated revisions.
 *
 * Keyed by the structured pair, not a delimiter-joined string, matching
 * `core/catalog/reference-counts.ts`'s own convention and for the same
 * reason: a workflow `name` or `revision` containing a colon, or equal to
 * `'__proto__'`/`'toString'`, is always handled correctly. `revision`
 * strings are caller-chosen (`buildWorkflowRevisionManifest`'s explicit
 * `options.revision`) and are not guaranteed unique across different
 * workflow `name`s, so a bare `Map<revision, RevisionRealmPool>` would risk
 * two unrelated workflows' same-spelled revision colliding on one pool.
 *
 * This registry does not itself subscribe to `catalog:revision-draining` /
 * `catalog:revision-activated` events — wiring it into a live `Engine` (a
 * new opt-in `EngineInternals` field plus a listener installed wherever
 * revision realms are enabled) is future integration work this slice does
 * not build. `markInactive`/`markActive` are the seam that wiring would
 * call.
 *
 * @module core/realm/revision-realm-registry
 */

import type { RevisionRealmPoolDiagnostics } from './revision-realm-diagnostics.ts';
import {
  RevisionRealmPool,
  type RevisionRealmAcquireOutcome,
  type RevisionRealmPoolOptions,
  type RevisionRealmTransport,
} from './revision-realm-pool.ts';
import type { RevisionRealm } from './revision-realm.ts';

export interface RevisionRealmConfig {
  readonly workerUrl: string | URL;
  readonly expectedWorkflowTypes: readonly string[];
  readonly expectedArtifactDigest?: string;
  /** Upper bound on realms concurrently warmed for this one `(name, revision)`. Defaults to {@link DEFAULT_REVISION_REALM_CONCURRENCY}. */
  readonly concurrency?: number;
  readonly maxRestarts?: number;
  readonly realmReadyTimeoutMs?: number;
  readonly maxProtocolMessageBytes?: number;
  readonly workerName?: string;
  /** `'worker'`-transport-only. Ignored under `'child-process'`. */
  readonly smol?: boolean;
  /** Selects the real transport this `(name, revision)`'s realms are spawned over. Defaults to `'worker'` (COR-246; unchanged from before this option existed). */
  readonly transport?: RevisionRealmTransport;
  /** `'child-process'`-transport-only. Ignored under `'worker'`. See `ChildProcessRealmOptions.env`'s own doc. */
  readonly env?: Readonly<Record<string, string>>;
}

export const DEFAULT_REVISION_REALM_CONCURRENCY = 4;

/**
 * Owns every `(name, revision)`'s {@link RevisionRealmPool}. See the module
 * doc for the keying rationale and what remains unwired.
 */
export class RevisionRealmRegistry {
  readonly #pools = new Map<string, Map<string, RevisionRealmPool>>();

  /**
   * Ensure a pool exists for `(name, revision)`, creating it (with no realms
   * warmed yet — warming happens lazily on first {@link
   * RevisionRealmPool.acquireForExecution}) if this is the first time this
   * exact revision has been seen. Calling this again for the same `(name,
   * revision)` returns the existing pool unchanged; `config` is only
   * consulted on first creation.
   */
  ensurePool(name: string, revision: string, config: RevisionRealmConfig): RevisionRealmPool {
    const byRevision = this.#poolsForName(name);
    const existing = byRevision.get(revision);
    if (existing) return existing;

    const pool = new RevisionRealmPool(this.#buildPoolOptions(revision, config));
    byRevision.set(revision, pool);
    return pool;
  }

  /** Assemble one `(name, revision)`'s `RevisionRealmPoolOptions` from its `RevisionRealmConfig`, split out of {@link ensurePool} to keep that method's own cyclomatic complexity under this package's lint ceiling. */
  #buildPoolOptions(revision: string, config: RevisionRealmConfig): RevisionRealmPoolOptions {
    return {
      workflowRevision: revision,
      workerUrl: config.workerUrl,
      expectedWorkflowTypes: config.expectedWorkflowTypes,
      concurrency: config.concurrency ?? DEFAULT_REVISION_REALM_CONCURRENCY,
      ...(config.expectedArtifactDigest === undefined
        ? {}
        : { expectedArtifactDigest: config.expectedArtifactDigest }),
      ...(config.maxRestarts === undefined ? {} : { maxRestarts: config.maxRestarts }),
      ...(config.realmReadyTimeoutMs === undefined
        ? {}
        : { realmReadyTimeoutMs: config.realmReadyTimeoutMs }),
      ...(config.maxProtocolMessageBytes === undefined
        ? {}
        : { maxProtocolMessageBytes: config.maxProtocolMessageBytes }),
      ...(config.workerName === undefined ? {} : { workerName: config.workerName }),
      ...(config.smol === undefined ? {} : { smol: config.smol }),
      ...(config.transport === undefined ? {} : { transport: config.transport }),
      ...(config.env === undefined ? {} : { env: config.env }),
    };
  }

  getPool(name: string, revision: string): RevisionRealmPool | undefined {
    return this.#pools.get(name)?.get(revision);
  }

  /** Warm/reuse a realm for a new execution of `(name, revision)`. Refused with `revision-not-active` when no pool has been {@link ensurePool}d for it, matching {@link RevisionRealmPool.acquireForExecution}'s own refusal for a revision that has since gone inactive. */
  async acquireForExecution(
    name: string,
    revision: string,
    executionToken: string,
  ): Promise<RevisionRealmAcquireOutcome> {
    const pool = this.getPool(name, revision);
    if (!pool) return { ok: false, reason: 'revision-not-active' };
    return pool.acquireForExecution(executionToken);
  }

  /**
   * Release a realm whose execution finished, through the pool that owns
   * `(name, revision)`, and reclaim that pool entirely once it is fully
   * drained — "a drained realm with no pinned work terminates."
   */
  releaseAfterExecution(name: string, revision: string, realm: RevisionRealm): void {
    const pool = this.getPool(name, revision);
    if (!pool) return;
    pool.releaseAfterExecution(realm);
    this.#reclaimIfDrained(name, revision, pool);
  }

  /** Drop a realm that crashed mid-execution and reclaim the pool if that made it fully drained. */
  forgetCrashedRealm(name: string, revision: string, realm: RevisionRealm): void {
    const pool = this.getPool(name, revision);
    if (!pool) return;
    pool.forgetCrashedRealm(realm);
    this.#reclaimIfDrained(name, revision, pool);
  }

  /**
   * Mark `(name, revision)` no longer the catalog's active pointer — the
   * seam a `catalog:revision-draining` listener would call. Idle realms are
   * reclaimed immediately; realms mid-execution are left running and
   * self-release through {@link releaseAfterExecution}. Reclaims the pool
   * entirely if it was already fully drained (never warmed, or every realm
   * already idle).
   */
  markInactive(name: string, revision: string): void {
    const pool = this.getPool(name, revision);
    if (!pool) return;
    pool.markInactive();
    this.#reclaimIfDrained(name, revision, pool);
  }

  /** Mark `(name, revision)` the catalog's active pointer again — the seam a `catalog:revision-activated` listener would call for a revision reactivated after having gone inactive. A no-op if no pool exists for it (a fresh revision's pool is created active by {@link ensurePool}). */
  markActive(name: string, revision: string): void {
    this.getPool(name, revision)?.markActive();
  }

  /**
   * Active execution realm count for `(name, revision)` — wired into
   * `WorkflowRevisionReferenceCounts.activeExecutionRealms` (COR-249). Reads
   * `0` for a `(name, revision)` this registry has never pooled, matching
   * every other reference-count field's "absent means zero" convention.
   */
  activeRealmCount(name: string, revision: string): number {
    return this.getPool(name, revision)?.activeRealmCount ?? 0;
  }

  /**
   * Bounded diagnostics for every `(name, revision)` pool this registry
   * currently owns — per-pool active-pointer state plus each pool's own
   * {@link RevisionRealmPool.diagnostics} snapshot (COR-243). Feeds
   * `weft.realms.diagnostics`; never returns manifest or contract content.
   */
  listDiagnostics(): readonly RevisionRealmPoolDiagnostics[] {
    const result: RevisionRealmPoolDiagnostics[] = [];
    for (const [name, byRevision] of this.#pools) {
      for (const [revision, pool] of byRevision) {
        result.push({
          name,
          revision,
          revisionActive: pool.isReferenced(),
          realms: pool.diagnostics(),
        });
      }
    }
    return result;
  }

  /** Dispose every pool this registry owns, discarding every realm regardless of state. */
  dispose(): void {
    for (const byRevision of this.#pools.values()) {
      for (const pool of byRevision.values()) pool.dispose();
    }
    this.#pools.clear();
  }

  #poolsForName(name: string): Map<string, RevisionRealmPool> {
    let byRevision = this.#pools.get(name);
    if (!byRevision) {
      byRevision = new Map();
      this.#pools.set(name, byRevision);
    }
    return byRevision;
  }

  #reclaimIfDrained(name: string, revision: string, pool: RevisionRealmPool): void {
    if (!pool.isDrained) return;
    pool.dispose();
    const byRevision = this.#pools.get(name);
    byRevision?.delete(revision);
    if (byRevision && byRevision.size === 0) this.#pools.delete(name);
  }
}
