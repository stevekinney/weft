/**
 * Deterministic fake revision realm (COR-117).
 *
 * Drives {@link RealmLifecycle} and {@link validateRealmTurnEnvelope} the
 * same way a real transport adapter eventually will — a real Worker
 * (COR-249) or a Bun IPC child process (COR-246) — without spawning
 * anything. Every state change here happens synchronously in response to a
 * method call, so tests observe transitions and rejections directly, never
 * by polling or waiting on a timer.
 *
 * This is intentionally the ONLY adapter that exists this slice. The port
 * this class exposes (`sendReady`, `activate`, `dispatchTurn`,
 * `acceptResult`, `beginDrain`, `terminate`, `crash`, `restart`) is what
 * COR-249's real Worker realm and COR-246's child-process realm are
 * expected to implement against the same lifecycle and protocol modules —
 * see the design note for how those later slices attach.
 *
 * The `.test-support.ts` suffix is excluded from lint's complexity and
 * max-lines ceilings, per this package's existing convention (see
 * `src/testing/*.test-support.ts`). Unlike some other packages in this
 * workspace, `@lostgradient/weft` ships no build step — it exports
 * TypeScript source directly — so there is no `dist/` for this suffix to
 * additionally be excluded from.
 *
 * @module core/realm/fake-realm.test-support
 */

import { buildInternalRealmManifest } from '../../worker/manifest/internal-realm.ts';
import { WORKER_PROTOCOL_VERSION } from '../worker-protocol.ts';
import type { RealmReadyOutcome } from '../worker-realm-readiness.ts';
import { validateRealmReadyMessage } from '../worker-realm-readiness.ts';
import { RealmLifecycle, type RealmLifecycleDependencies } from './realm-lifecycle.ts';
import {
  RealmEnvelopeMismatchError,
  validateRealmTurnEnvelope,
  type RealmTurnEnvelope,
} from './realm-protocol.ts';

/** What the fake realm expects every turn it is dispatched to carry, apart from the per-turn `turnId`. */
export interface FakeRealmActivation {
  readonly workflowRevision: string;
  readonly realmGeneration: string;
  readonly executionToken: string;
}

/** Outcome of {@link FakeRealm.acceptResult}: whether a result was applied or refused as untimely/unknown. */
export type FakeRealmAcceptResultOutcome =
  | { accepted: true; result: unknown }
  | { accepted: false; reason: 'realm-not-active' | 'unknown-turn' };

interface PendingTurn {
  readonly envelope: RealmTurnEnvelope;
  settle: ((outcome: FakeRealmAcceptResultOutcome) => void) | null;
}

export interface FakeRealmDependencies extends RealmLifecycleDependencies {
  readonly expectedWorkflowTypes: readonly string[];
  /** Omit to reuse the existing generic Worker path's behavior (no digest check). */
  readonly expectedArtifactDigest?: string;
}

/**
 * One fake realm instance. Each instance owns its own {@link RealmLifecycle}
 * and pending-turn set — nothing is shared between instances, which is what
 * makes "a crashed realm isolates sibling revisions" true by construction
 * rather than by a check this class has to perform.
 */
export class FakeRealm {
  readonly lifecycle: RealmLifecycle;
  readonly #dependencies: FakeRealmDependencies;
  readonly #pendingTurns = new Map<number, PendingTurn>();
  #activation: FakeRealmActivation | null = null;
  #nextExpectedTurnId = 1;

  constructor(dependencies: FakeRealmDependencies) {
    this.#dependencies = dependencies;
    this.lifecycle = new RealmLifecycle(dependencies);
  }

  /** Build the manifest this fake realm would honestly advertise for its configured workflow types. */
  buildReadyMessage(realmGeneration: string): Record<string, unknown> {
    return {
      type: 'ready',
      protocolVersion: WORKER_PROTOCOL_VERSION,
      realmGeneration,
      manifest: buildInternalRealmManifest(this.#dependencies.expectedWorkflowTypes),
    };
  }

  /**
   * Run the realm-ready handshake: `Warming` -> `Ready` on a validated
   * manifest and artifact digest, `Warming` -> `Crashed` otherwise. A realm
   * cannot enter `Ready` or receive a turn without going through this.
   */
  async sendReady(message: unknown): Promise<RealmReadyOutcome> {
    const outcome = await validateRealmReadyMessage(message, {
      getExpectedWorkflowTypes: () => this.#dependencies.expectedWorkflowTypes,
      maxProtocolMessageBytes: undefined,
      getExpectedArtifactDigest: () => this.#dependencies.expectedArtifactDigest,
    });
    this.lifecycle.markReady({ ok: outcome.ok });
    return outcome;
  }

  /** `Ready` -> `Active`. `activation` fixes the three per-generation identifiers every subsequent turn is checked against. */
  activate(activation: FakeRealmActivation): void {
    this.lifecycle.activate();
    this.#activation = activation;
    this.#nextExpectedTurnId = 1;
  }

  /**
   * Dispatch one turn. Rejects immediately (no pending turn is created) when
   * the realm is not `Active`, or when the envelope disagrees with the
   * fixed activation identifiers or the next expected `turnId` — this is
   * the "wrong revision, realm generation, execution token, or turn ID is
   * rejected" acceptance criterion.
   */
  dispatchTurn(envelope: RealmTurnEnvelope): Promise<unknown> {
    if (this.lifecycle.state !== 'active' || this.#activation === null) {
      return Promise.reject(
        new Error(`Fake realm cannot accept a turn while ${this.lifecycle.state}`),
      );
    }

    const expected: RealmTurnEnvelope = { ...this.#activation, turnId: this.#nextExpectedTurnId };
    const validation = validateRealmTurnEnvelope(expected, envelope);
    if (!validation.ok) {
      return Promise.reject(new RealmEnvelopeMismatchError(validation));
    }

    this.#nextExpectedTurnId += 1;
    return new Promise((resolve, reject) => {
      this.#pendingTurns.set(envelope.turnId, {
        envelope,
        settle: (outcome) => {
          if (outcome.accepted) resolve(outcome.result);
          else reject(new Error(`Turn ${envelope.turnId} was not accepted: ${outcome.reason}`));
        },
      });
    });
  }

  /**
   * Apply a realm's result for `envelope.turnId`. Refused as
   * `realm-not-active` when the realm is not `Active` — this is what makes
   * a drained or terminated realm unable to emit an accepted late result,
   * regardless of whether the turn was ever dispatched. Refused as
   * `unknown-turn` when no pending turn matches `envelope.turnId`, so an
   * accepted result is always tied to a specific dispatch this fake realm
   * itself created.
   *
   * Once a pending turn is found, its stored {@link RealmTurnEnvelope} — the
   * one `dispatchTurn` validated and kept, not merely the `turnId` used to
   * look it up — is compared against `envelope` with
   * {@link validateRealmTurnEnvelope}. Any mismatch throws the same
   * {@link RealmEnvelopeMismatchError} the dispatch direction rejects with,
   * fencing this direction too: a slow realm's answer to a turn the host
   * already gave up on (for example a stale result from a `realmGeneration`
   * that has since crashed and been replaced) cannot resolve the pending
   * turn, even when a fresh turn happens to reuse the same `turnId` after a
   * restart. The pending turn itself is left untouched on a mismatch, so its
   * real, still-outstanding caller keeps waiting for its own result.
   */
  acceptResult(envelope: RealmTurnEnvelope, result: unknown): FakeRealmAcceptResultOutcome {
    if (this.lifecycle.state !== 'active') {
      return { accepted: false, reason: 'realm-not-active' };
    }
    const pending = this.#pendingTurns.get(envelope.turnId);
    if (!pending || !pending.settle) {
      return { accepted: false, reason: 'unknown-turn' };
    }

    const validation = validateRealmTurnEnvelope(pending.envelope, envelope);
    if (!validation.ok) {
      throw new RealmEnvelopeMismatchError(validation);
    }

    const outcome: FakeRealmAcceptResultOutcome = { accepted: true, result };
    const settle = pending.settle;
    pending.settle = null;
    this.#pendingTurns.delete(envelope.turnId);
    settle(outcome);
    return outcome;
  }

  /** `Active` -> `Draining`. No new turn may be dispatched afterward. */
  beginDrain(): void {
    this.lifecycle.beginDrain();
  }

  /**
   * `Draining` -> `Terminated`, rejecting every turn still pending. Once a
   * realm is not `Active`, {@link acceptResult} refuses everything with
   * `realm-not-active`, so a turn dispatched before `beginDrain()` and
   * still outstanding at `terminate()` can never be legitimately accepted
   * — its caller's `dispatchTurn()` promise would otherwise stay
   * unsettled forever. Settling it here, the same way {@link crash} does,
   * closes that hang; it is not the cooperative in-flight completion
   * during `Draining` that COR-113 (Crash, Cancellation, and Disposal
   * Hardening) still owns, which would let such a turn resolve
   * successfully instead of being rejected.
   */
  terminate(): void {
    this.lifecycle.terminate();
    this.#settlePendingTurns();
  }

  /**
   * Crash the realm: transitions to `Crashed` and settles every pending
   * turn with a rejection — "realm crash settles all pending turns." Only
   * this instance's own pending turns are touched; a sibling `FakeRealm`
   * for a different revision is a separate object with its own map, so
   * isolation holds structurally.
   */
  crash(): void {
    this.lifecycle.crash();
    this.#settlePendingTurns();
  }

  /** Reject every still-pending turn with `realm-not-active`. Shared by {@link crash} and {@link terminate}, the two transitions after which no pending turn can ever be legitimately accepted. */
  #settlePendingTurns(): void {
    for (const [turnId, pending] of this.#pendingTurns) {
      const settle = pending.settle;
      pending.settle = null;
      settle?.({ accepted: false, reason: 'realm-not-active' });
      this.#pendingTurns.delete(turnId);
    }
  }

  /** Bounded `Crashed` -> `Warming` restart. See {@link RealmLifecycle.restart}. */
  restart(): ReturnType<RealmLifecycle['restart']> {
    return this.lifecycle.restart();
  }

  /** Number of turns still awaiting a settled result. */
  get pendingTurnCount(): number {
    return this.#pendingTurns.size;
  }
}
