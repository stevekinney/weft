/**
 * Bounded per-realm and per-`(name, revision)` diagnostics shapes (COR-243).
 *
 * `RevisionRealmPool` and `RevisionRealmRegistry` already track everything
 * this needs — {@link import('./revision-realm.ts').RevisionRealm}'s own
 * public surface (`lifecycle.state`, `lifecycle.restartCount`,
 * `activation.realmGeneration`, `pendingTurnCount`) was shaped by COR-117/
 * COR-249 before this project existed. This module only names the bounded,
 * wire-safe projection `weft.realms.diagnostics` (COR-243) reports: the
 * lifecycle state, activation generation, restart count, and in-flight turn
 * count for every realm this host currently tracks — never a manifest,
 * contract, or raw payload.
 *
 * Split into its own file (rather than inlined into `revision-realm-pool.ts`
 * or `revision-realm-registry.ts`) because both of those modules need it:
 * `RevisionRealmPool.diagnostics()` produces the per-realm entries,
 * `RevisionRealmRegistry.listDiagnostics()` composes them per `(name,
 * revision)`, and a server operation composes the registry's output again —
 * one shared shape avoids three slightly different ad hoc object literals.
 *
 * @module core/realm/revision-realm-diagnostics
 */

import type { RealmLifecycleState } from './realm-lifecycle.ts';

/**
 * One realm's bounded diagnostics snapshot at read time. `realmGeneration`
 * is `null` until the realm's ready handshake has completed at least once
 * (a `warming` realm has none yet); `pendingTurnCount` is the realm's own
 * {@link import('./revision-realm.ts').RevisionRealm.pendingTurnCount} —
 * turns dispatched to this realm that have not yet settled.
 */
export interface RevisionRealmDiagnosticsEntry {
  readonly state: RealmLifecycleState;
  readonly realmGeneration: string | null;
  readonly restartCount: number;
  readonly pendingTurnCount: number;
}

/**
 * One `(name, revision)`'s realm pool, diagnostically: whether the catalog
 * still considers this revision its active pointer
 * ({@link import('./revision-realm-pool.ts').RevisionRealmPool.isReferenced}),
 * and a bounded snapshot of every realm the pool currently tracks (idle +
 * active + draining — never terminated/discarded realms, which the pool
 * itself no longer holds).
 */
export interface RevisionRealmPoolDiagnostics {
  readonly name: string;
  readonly revision: string;
  readonly revisionActive: boolean;
  readonly realms: readonly RevisionRealmDiagnosticsEntry[];
}
