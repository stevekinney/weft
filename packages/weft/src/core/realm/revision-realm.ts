/**
 * Transport-agnostic revision realm port (COR-246).
 *
 * The exact shape `WorkerRealm` (COR-249, a real Bun `Worker`) and {@link
 * import('./child-process-realm.ts').ChildProcessRealm} (COR-246, a real
 * `Bun.spawn` IPC child process) both already implement —
 * `RevisionRealmPool`, `RevisionRealmRegistry`, and
 * `RevisionRealmExecutionStrategy` hold and route to this interface instead
 * of a concrete adapter class, so a pool can warm either transport behind
 * one `RevisionRealmConfig.transport` selection (default `'worker'`,
 * unchanged) without the routing/pooling layer knowing which one backs a
 * given instance.
 *
 * Neither adapter class declares `implements RevisionRealm` — TypeScript's
 * structural typing already makes each one assignable here, and every
 * method/property below is copied verbatim from `WorkerRealm`'s own already-
 * shipped public surface, so leaving the declaration off costs nothing and
 * means this file is the only thing a future third transport's own addition
 * would touch, not every existing adapter's class declaration too.
 *
 * `FakeRealm` (COR-117) deliberately does NOT implement this interface — its
 * port is synchronous and test-only (`sendReady`/`acceptResult` instead of a
 * real handshake/message loop with `waitUntilReady`/an async
 * `dispatchTurn`), and no production code ever holds a `FakeRealm` next to a
 * real adapter through one shared type. `realm-conformance.test-support.ts`
 * bridges that difference through its own per-realm-kind harness, not
 * through this interface.
 *
 * @module core/realm/revision-realm
 */

import type { RealmReadyOutcome } from '../worker-realm-readiness.ts';
import type { RealmLifecycle, RealmRestartOutcome } from './realm-lifecycle.ts';
import type { RealmTurnEnvelope } from './realm-protocol.ts';

/** Activation identifiers fixed for a revision realm's entire `Active` lifetime, shared by every transport. */
export interface RevisionRealmActivation {
  readonly workflowRevision: string;
  readonly realmGeneration: string;
  readonly executionToken: string;
}

/**
 * The port `RevisionRealmPool` acquires, activates, dispatches turns to, and
 * eventually drains and terminates — identical across every real transport.
 * See the module doc for why `FakeRealm` is excluded, and each concrete
 * adapter's own module doc for its method-by-method contract (envelope
 * fencing, idempotent shutdown, bounded restart): this interface only names
 * the shared shape, it does not restate those contracts.
 */
export interface RevisionRealm {
  readonly lifecycle: RealmLifecycle;
  readonly activation: RevisionRealmActivation | null;
  readonly pendingTurnCount: number;
  waitUntilReady(): Promise<RealmReadyOutcome>;
  activate(activation: RevisionRealmActivation): void;
  dispatchTurn(envelope: RealmTurnEnvelope, input: unknown): Promise<unknown>;
  beginDrain(): void;
  terminate(): void;
  crash(): void;
  restart(): RealmRestartOutcome;
  discard(): void;
}
