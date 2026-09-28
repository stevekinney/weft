/**
 * A pool of {@link RevisionRealm} instances scoped to one immutable artifact
 * revision (COR-249, transport selection extended by COR-246).
 *
 * "One realm pool per immutable artifact revision" (COR-249's own issue
 * text) means every realm this pool ever warms is fixed, at construction,
 * to one `workerUrl`, one `expectedWorkflowTypes` list, and one
 * `expectedArtifactDigest` — never place unrelated revisions in one Worker
 * (or child process). A `RevisionRealmRegistry` (COR-249) is what owns one
 * `RevisionRealmPool` per `(name, revision)` and routes a start to the
 * correct one.
 *
 * Every realm this pool warms is also fixed to one `transport`: `'worker'`
 * (a real Bun `Worker`, the default — unchanged from before COR-246) or
 * `'child-process'` (a real `Bun.spawn` IPC child process). `workerUrl`
 * doubles as the child-process transport's bootstrap script path — both
 * transports speak the identical realm protocol over a different wire, so
 * one field naming "the bootstrap this pool spawns" is enough; see
 * `ChildProcessRealmOptions.scriptPath`'s own doc for why a `string | URL`
 * transport-selection URL is the correct shape regardless of which real
 * process type ultimately runs it.
 *
 * Each realm in this pool serves exactly one execution end to end (see
 * `worker-realm.ts`'s and `child-process-realm.ts`'s module docs):
 * `acquireForExecution` warms (or reuses an idle, already-`Ready`) realm and
 * activates it for a new execution's `executionToken`; `releaseAfterExecution`
 * drains and terminates it once that execution finishes, "terminate drained
 * Workers." A pool does not reuse a realm across two different executions —
 * each `acquireForExecution` either takes an idle `Ready` realm this pool
 * warmed ahead of demand, or warms a fresh one on the spot, bounded by
 * `concurrency`.
 *
 * @module core/realm/revision-realm-pool
 */

import type { ChildProcessRealm, ChildProcessRealmOptions } from './child-process-realm.ts';
import type { RevisionRealmDiagnosticsEntry } from './revision-realm-diagnostics.ts';
import type { RevisionRealm } from './revision-realm.ts';
import { WorkerRealm, type WorkerRealmOptions } from './worker-realm.ts';

/**
 * `child-process-realm.ts` uses `Bun.spawn` and `node:url`, neither of which
 * exists in a browser -- and `RevisionRealmPool` is reachable from this
 * package's root `Engine` export, which the root's own browser-bundle
 * portability gate (`src/root-testing-surface.test.ts`, COR-1192) builds and
 * scans. A STATIC `import` of `child-process-realm.ts` here would bundle
 * that code into the browser build regardless of whether `transport:
 * 'child-process'` is ever actually selected at runtime. Loading it through
 * `import()` with a specifier held in a variable (not a string literal
 * `import()` call, which Bun's bundler still resolves and inlines the same
 * way a static `import` does -- confirmed directly against Bun 1.4.2)
 * is what keeps the bundler from tracing into it at all: the browser build
 * emits an unresolved runtime `import(...)` call instead of inlining the
 * module, so `Bun.spawn` never appears in that bundle's output. Type-only
 * imports above are erased entirely and carry no such risk.
 */
const CHILD_PROCESS_REALM_MODULE_SPECIFIER = './child-process-realm.ts';
let cachedChildProcessRealmConstructor: Promise<typeof ChildProcessRealm> | undefined;

function loadChildProcessRealmConstructor(): Promise<typeof ChildProcessRealm> {
  cachedChildProcessRealmConstructor ??= import(CHILD_PROCESS_REALM_MODULE_SPECIFIER).then(
    (module_: { ChildProcessRealm: typeof ChildProcessRealm }) => module_.ChildProcessRealm,
  );
  return cachedChildProcessRealmConstructor;
}

/** Which real transport a `RevisionRealmPool` spawns realms over. Omitted (or `'worker'`) is the unchanged default — see the module doc. */
export type RevisionRealmTransport = 'worker' | 'child-process';

export interface RevisionRealmPoolOptions {
  readonly workflowRevision: string;
  readonly workerUrl: string | URL;
  readonly expectedWorkflowTypes: readonly string[];
  readonly expectedArtifactDigest?: string;
  /** Upper bound on realms concurrently warmed (idle or active) for this revision. */
  readonly concurrency: number;
  readonly maxRestarts?: number;
  readonly realmReadyTimeoutMs?: number;
  readonly maxProtocolMessageBytes?: number;
  readonly workerName?: string;
  /** `'worker'`-transport-only. Ignored under `'child-process'`. */
  readonly smol?: boolean;
  /** Selects the real transport every realm this pool warms is spawned over. Defaults to `'worker'` — see the module doc. */
  readonly transport?: RevisionRealmTransport;
  /** `'child-process'`-transport-only. Ignored under `'worker'`. See `ChildProcessRealmOptions.env`'s own doc. */
  readonly env?: Readonly<Record<string, string>>;
}

export type RevisionRealmAcquireOutcome =
  | { ok: true; realm: RevisionRealm }
  | {
      ok: false;
      reason: 'revision-not-active' | 'realm-ready-handshake-failed' | 'pool-at-capacity';
      error?: string;
    };

/**
 * One revision's pool of {@link RevisionRealm} instances — either transport
 * (`WorkerRealm` or `ChildProcessRealm`), fixed at construction; see the
 * module doc. `isReferenced` (a {@link
 * import('./realm-lifecycle.ts').RealmLifecycleDependencies} dependency
 * every realm this pool constructs shares) is this pool's own "am I still
 * active or does a realm still have work" check — see {@link
 * RevisionRealmPool.isReferenced}, not a per-realm concept.
 */
export class RevisionRealmPool {
  readonly #options: RevisionRealmPoolOptions;
  readonly #realms = new Set<RevisionRealm>();
  #revisionActive = true;
  #disposed = false;
  /**
   * Count of `acquireForExecution` calls currently suspended on `await
   * realm.waitUntilReady()` (or the recheck immediately after it), for a
   * realm that is not yet `Active`. `isDrained` must stay `false` while
   * this is nonzero: a realm mid-handshake is neither counted by
   * `activeRealmCount` (it is not yet `Active`) nor discarded by {@link
   * markInactive} (which only reclaims idle `Ready` realms), so without
   * this counter a registry's `#reclaimIfDrained` could dispose the whole
   * pool -- terminating the in-flight realm's underlying Worker -- while
   * an acquisition genuinely still has a claim on it.
   */
  #inFlightAcquisitions = 0;
  /**
   * Count of `#warmNewRealmIfUnderCapacity` calls currently suspended
   * resolving the child-process transport's dynamic `import()` (COR-246),
   * reserved BEFORE that await so a concurrent call's own capacity check
   * sees it — otherwise two concurrent `acquireForExecution` calls could
   * both pass the capacity gate while the first's realm is still being
   * constructed and never added to `#realms` yet. Also included in {@link
   * isDrained} for the identical reason `#inFlightAcquisitions` is: a realm
   * under construction is not yet in `#realms` and must not let this pool
   * be reclaimed out from under it.
   */
  #warmingReservations = 0;

  constructor(options: RevisionRealmPoolOptions) {
    this.#options = options;
  }

  /**
   * Warm (or reuse an idle `Ready`) realm and activate it for one new
   * execution. Refused with `revision-not-active` once {@link markInactive}
   * has been called — "activation routes new starts only to the newly
   * active revision" — never by silently routing a new start to a revision
   * that is no longer current. An in-flight execution that already holds a
   * realm is unaffected: it keeps dispatching turns to that same realm
   * directly, "the old realm remains available for runs pinned to it."
   */
  async acquireForExecution(executionToken: string): Promise<RevisionRealmAcquireOutcome> {
    if (this.#disposed || !this.#revisionActive) {
      return { ok: false, reason: 'revision-not-active' };
    }

    // Branching on transport BEFORE the `??` (rather than inside one shared
    // async warm method) matters for more than style: the `'worker'` branch
    // below is a plain synchronous call, so when it is taken, this
    // expression never touches `await` at all and `acquireForExecution`
    // does not suspend here -- preserving the exact synchronous
    // realm-construction-then-`#realms.add()` ordering
    // `revision-realm-pool.test.ts`'s "event-ordering proof (ordinary JS
    // run-to-completion semantics)" tests depend on. Only the
    // `'child-process'` branch's real dynamic import needs to suspend.
    const realm =
      this.#takeIdleReadyRealm() ??
      ((this.#options.transport ?? 'worker') === 'worker'
        ? this.#warmNewWorkerRealmIfUnderCapacity()
        : await this.#warmNewChildProcessRealmIfUnderCapacity());
    if (!realm) {
      return { ok: false, reason: 'pool-at-capacity' };
    }

    this.#inFlightAcquisitions += 1;
    try {
      const outcome = await realm.waitUntilReady();
      if (!outcome.ok) {
        // A rejected/timed-out ready handshake already leaves the realm's own
        // lifecycle in `Crashed` (see `WorkerRealm#settleReady`), but it never
        // terminates the underlying real Worker thread on its own -- that is
        // this pool's job, matching the existing `WorkerFaultHandler
        // .discardWorkerAndFailWorkflows` precedent for the identical failure
        // in the generic Worker-execution-mode path
        // (`worker-execution-strategy.ts`'s `#ensureRealmReady`). Without this,
        // the Worker thread outlives its dropped realm indefinitely.
        realm.discard();
        this.#realms.delete(realm);
        return { ok: false, reason: 'realm-ready-handshake-failed', error: outcome.error };
      }

      if (this.#disposed || !this.#revisionActive) {
        // The revision went inactive (or the whole pool was disposed) while
        // this realm's ready handshake was still in flight. "Activation
        // routes new starts only to the newly active revision" must hold
        // even though the realm itself finished warming successfully in the
        // interim -- discard the freshly-warmed realm instead of activating
        // it for a start nothing should route to any more.
        realm.discard();
        this.#realms.delete(realm);
        return { ok: false, reason: 'revision-not-active' };
      }

      realm.activate({
        workflowRevision: this.#options.workflowRevision,
        realmGeneration: outcome.realmGeneration,
        executionToken,
      });
      return { ok: true, realm };
    } finally {
      this.#inFlightAcquisitions -= 1;
    }
  }

  /**
   * Release a realm whose one execution finished (successfully, by failure,
   * or by cancellation). Drains and terminates it and drops it from this
   * pool's bookkeeping — a realm is never reused across two executions in
   * this slice (see the module doc). A no-op for a realm this pool does not
   * own (already released, or crashed and self-removed).
   */
  releaseAfterExecution(realm: RevisionRealm): void {
    if (!this.#realms.has(realm)) return;
    if (realm.lifecycle.state === 'active') realm.beginDrain();
    if (realm.lifecycle.state === 'draining') realm.terminate();
    this.#realms.delete(realm);
  }

  /** Drop a realm that crashed mid-execution from this pool's bookkeeping, without attempting to drain/terminate it again (its own crash handling already did that). */
  forgetCrashedRealm(realm: RevisionRealm): void {
    this.#realms.delete(realm);
  }

  /**
   * Mark this revision no longer the catalog's active pointer (COR-249:
   * "activation routes new starts only to the newly active revision"). Idle
   * (warmed but never-activated) realms are reclaimed immediately —
   * "terminate drained Workers" — since nothing is pinned to them; realms
   * mid-execution are left alone (they self-release through
   * {@link releaseAfterExecution} when their own execution finishes).
   */
  markInactive(): void {
    this.#revisionActive = false;
    for (const realm of this.#realms) {
      if (realm.lifecycle.state === 'ready') {
        realm.discard();
        this.#realms.delete(realm);
      }
    }
  }

  /** Re-mark this revision as the catalog's active pointer again (a later activation reactivating an older revision). */
  markActive(): void {
    this.#revisionActive = true;
  }

  /**
   * Active realm count — realms with at least one execution mid-flight.
   * Wired into `WorkflowRevisionReferenceCounts.activeExecutionRealms`
   * (COR-249).
   */
  get activeRealmCount(): number {
    let count = 0;
    for (const realm of this.#realms) if (realm.lifecycle.state === 'active') count += 1;
    return count;
  }

  /** Total realms this pool currently tracks (idle + active + draining), for diagnostics/tests. */
  get realmCount(): number {
    return this.#realms.size;
  }

  /**
   * Bounded, per-realm diagnostics snapshot for every realm this pool
   * currently tracks (idle + active + draining) — state, activation
   * generation, restart count, and in-flight turn count (COR-243). See
   * {@link import('./revision-realm-diagnostics.ts').RevisionRealmDiagnosticsEntry}'s
   * own doc for field semantics. `RevisionRealmRegistry.listDiagnostics`
   * composes this per `(name, revision)` for `weft.realms.diagnostics`.
   */
  diagnostics(): readonly RevisionRealmDiagnosticsEntry[] {
    return [...this.#realms].map((realm) => ({
      state: realm.lifecycle.state,
      realmGeneration: realm.activation?.realmGeneration ?? null,
      restartCount: realm.lifecycle.restartCount,
      pendingTurnCount: realm.pendingTurnCount,
    }));
  }

  /**
   * True once nothing references this revision any more: it is not the
   * active pointer, no realm is mid-execution, and no acquisition is still
   * mid-handshake for it. This is the point at which a {@link
   * import('./revision-realm-registry.ts').RevisionRealmRegistry} can
   * reclaim the pool itself — "a drained realm with no pinned work
   * terminates." The in-flight-acquisition check matters exactly when a
   * realm has finished warming but the pool has not yet decided whether to
   * activate or discard it (see `acquireForExecution`'s post-handshake
   * recheck) — reclaiming the pool during that window would terminate a
   * realm a caller still has a live claim on.
   */
  get isDrained(): boolean {
    return (
      !this.#revisionActive &&
      this.activeRealmCount === 0 &&
      this.#inFlightAcquisitions === 0 &&
      this.#warmingReservations === 0
    );
  }

  /** Whether this pool still considers its revision referenced — the {@link import('./realm-lifecycle.ts').RealmLifecycleDependencies.isReferenced} every realm this pool constructs is given. Deliberately excludes `activeExecutionRealms` from its own reasoning: counting the realm asking the question would make an active revision's own realms permanently "referenced" even after the revision goes inactive, and a realm can never legitimately restart mid-drain regardless (see `markInactive`, which only ever discards *idle* realms). */
  isReferenced(): boolean {
    return this.#revisionActive;
  }

  /** Dispose the whole pool: discard every realm regardless of state. Used when a drained pool is finally removed from the registry, or on overall host shutdown. */
  dispose(): void {
    this.#disposed = true;
    for (const realm of this.#realms) realm.discard();
    this.#realms.clear();
  }

  #takeIdleReadyRealm(): RevisionRealm | undefined {
    for (const realm of this.#realms) {
      if (realm.lifecycle.state === 'ready') return realm;
    }
    return undefined;
  }

  /** The `'worker'`-transport warm path: unchanged from before COR-246, still fully synchronous. */
  #warmNewWorkerRealmIfUnderCapacity(): RevisionRealm | undefined {
    if (this.#realms.size + this.#warmingReservations >= this.#options.concurrency) {
      return undefined;
    }
    const realm = new WorkerRealm(this.#buildWorkerRealmOptions());
    this.#realms.add(realm);
    return realm;
  }

  /** The `'child-process'`-transport warm path (COR-246): the only one that needs the dynamic `import()` and its `#warmingReservations` capacity guard — see both members' own docs. */
  async #warmNewChildProcessRealmIfUnderCapacity(): Promise<RevisionRealm | undefined> {
    if (this.#realms.size + this.#warmingReservations >= this.#options.concurrency) {
      return undefined;
    }
    this.#warmingReservations += 1;
    try {
      const ChildProcessRealmConstructor = await loadChildProcessRealmConstructor();
      const realm = new ChildProcessRealmConstructor(this.#buildChildProcessRealmOptions());
      this.#realms.add(realm);
      return realm;
    } finally {
      this.#warmingReservations -= 1;
    }
  }

  #sharedRealmOptions(): {
    expectedWorkflowTypes: readonly string[];
    isReferenced: () => boolean;
    maxRestarts: number;
    expectedArtifactDigest?: string;
    realmReadyTimeoutMs?: number;
    maxProtocolMessageBytes?: number;
    workerName?: string;
  } {
    return {
      expectedWorkflowTypes: this.#options.expectedWorkflowTypes,
      isReferenced: () => this.isReferenced(),
      maxRestarts: this.#options.maxRestarts ?? 0,
      ...(this.#options.expectedArtifactDigest === undefined
        ? {}
        : { expectedArtifactDigest: this.#options.expectedArtifactDigest }),
      ...(this.#options.realmReadyTimeoutMs === undefined
        ? {}
        : { realmReadyTimeoutMs: this.#options.realmReadyTimeoutMs }),
      ...(this.#options.maxProtocolMessageBytes === undefined
        ? {}
        : { maxProtocolMessageBytes: this.#options.maxProtocolMessageBytes }),
      ...(this.#options.workerName === undefined ? {} : { workerName: this.#options.workerName }),
    };
  }

  #buildWorkerRealmOptions(): WorkerRealmOptions {
    return {
      workerUrl: this.#options.workerUrl,
      ...this.#sharedRealmOptions(),
      ...(this.#options.smol === undefined ? {} : { smol: this.#options.smol }),
    };
  }

  #buildChildProcessRealmOptions(): ChildProcessRealmOptions {
    return {
      scriptPath: this.#options.workerUrl,
      ...this.#sharedRealmOptions(),
      ...(this.#options.env === undefined ? {} : { env: this.#options.env }),
    };
  }
}
