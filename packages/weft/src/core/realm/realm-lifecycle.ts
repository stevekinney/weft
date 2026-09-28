/**
 * Revision realm lifecycle state machine (COR-117).
 *
 * The first slice of workflow revision isolation (`Weft: Workflow Revision
 * Isolation and Lifecycle`) defines a realm's lifecycle above whatever
 * transport eventually hosts it — a real Worker (COR-249) or a child
 * process (COR-246) — before either exists. This module has no dependency
 * on `Worker`, `Bun.spawn`, or any other transport primitive, so it is
 * exercised directly by a deterministic fake realm
 * ({@link import('./fake-realm.test-support.ts')}) and later reused
 * unchanged by both real adapters.
 *
 * States and legal transitions:
 *
 * ```text
 * Warming --markReady(ok)-->   Ready
 * Warming --markReady(fail)--> Crashed
 * Ready   --activate()-->      Active
 * Active  --beginDrain()-->    Draining
 * Active  --crash()-->         Crashed
 * Draining--terminate()-->     Terminated
 * Draining--crash()-->         Crashed
 * Crashed --restart()-->       Warming   (bounded, only when referenced)
 * ```
 *
 * `Ready` can also crash (a realm that finished its handshake but has not
 * yet been handed a workflow can still lose its underlying process) — see
 * {@link RealmLifecycle.crash}. `Terminated` has no outbound transition: a
 * terminated realm is done, and a fresh realm is warmed in its place rather
 * than reused. This slice does not build a memoized/idempotent disposal
 * promise on top of these transitions — that hardening is COR-113's scope.
 *
 * @module core/realm/realm-lifecycle
 */

/** Every state a revision realm can occupy. See the module doc for the transition diagram. */
export type RealmLifecycleState =
  'warming' | 'ready' | 'active' | 'draining' | 'terminated' | 'crashed';

/** Emitted synchronously to every {@link RealmLifecycle.onTransition} listener after a state change. */
export interface RealmLifecycleTransition {
  readonly from: RealmLifecycleState;
  readonly to: RealmLifecycleState;
}

/** Thrown when a caller invokes a transition method from a state that does not permit it. */
export class RealmLifecycleTransitionError extends Error {
  constructor(
    public readonly action: string,
    public readonly from: RealmLifecycleState,
  ) {
    super(`Realm lifecycle cannot ${action} from state '${from}'`);
    this.name = 'RealmLifecycleTransitionError';
  }
}

/** Why a {@link RealmLifecycle.restart} call left the realm in `Crashed` instead of moving it to `Warming`. */
export type RealmRestartRefusalReason = 'unreferenced' | 'restart-budget-exceeded';

export type RealmRestartOutcome = { ok: true } | { ok: false; reason: RealmRestartRefusalReason };

export interface RealmLifecycleDependencies {
  /**
   * Whether anything still references this revision (a non-terminal run
   * pinned to it, a pending dispatch, an in-flight start). A bounded
   * restart from `Crashed` is refused when nothing references the realm's
   * revision — restarting an unreferenced realm would warm a process
   * nothing needs, defeating the reclamation goal COR-249 is built around.
   */
  isReferenced: () => boolean;
  /**
   * Upper bound on how many times {@link RealmLifecycle.restart} may move
   * this realm from `Crashed` back to `Warming` over its lifetime. A crash
   * loop (a revision whose bootstrap always throws) must not restart
   * forever even while referenced.
   */
  maxRestarts: number;
}

/**
 * One realm's lifecycle state and transition rules. Holds no reference to a
 * `Worker`, socket, or process — a transport adapter drives this state
 * machine from its own events, it does not extend it.
 */
export class RealmLifecycle {
  readonly #dependencies: RealmLifecycleDependencies;
  readonly #listeners = new Set<(transition: RealmLifecycleTransition) => void>();
  #state: RealmLifecycleState = 'warming';
  #restartCount = 0;

  constructor(dependencies: RealmLifecycleDependencies) {
    this.#dependencies = dependencies;
  }

  get state(): RealmLifecycleState {
    return this.#state;
  }

  /** Number of times this realm has been restarted from `Crashed` to `Warming`. */
  get restartCount(): number {
    return this.#restartCount;
  }

  /** Subscribe to every transition. Returns an unsubscribe function. */
  onTransition(listener: (transition: RealmLifecycleTransition) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /**
   * Settle the one-time ready handshake: `Warming` moves to `Ready` on
   * success, or straight to `Crashed` on a rejected manifest/artifact
   * digest (see {@link import('../worker-realm-readiness.ts').validateRealmReadyMessage}) —
   * a realm can never enter `Ready` or run user code without a validated
   * handshake, because there is no other path into `Ready`.
   */
  markReady(outcome: { ok: boolean }): void {
    this.#assertState('markReady', ['warming']);
    this.#transitionTo(outcome.ok ? 'ready' : 'crashed');
  }

  /** `Ready` -> `Active`: the realm may now be routed workflow turns. */
  activate(): void {
    this.#assertState('activate', ['ready']);
    this.#transitionTo('active');
  }

  /** `Active` -> `Draining`: the realm accepts no new turns but is not yet gone. */
  beginDrain(): void {
    this.#assertState('beginDrain', ['active']);
    this.#transitionTo('draining');
  }

  /** `Draining` -> `Terminated`: the realm is gone and cannot be reused. */
  terminate(): void {
    this.#assertState('terminate', ['draining']);
    this.#transitionTo('terminated');
  }

  /**
   * Any post-handshake state but `Terminated` -> `Crashed`. A realm that
   * has not yet been handed a workflow (`Ready`) can still crash, as can
   * one mid-turn (`Active`) or mid-drain (`Draining`).
   */
  crash(): void {
    this.#assertState('crash', ['ready', 'active', 'draining']);
    this.#transitionTo('crashed');
  }

  /**
   * Bounded `Crashed` -> `Warming` restart. Refuses (without throwing) when
   * nothing references this realm's revision or the restart budget is
   * exhausted; both are ordinary business outcomes, not programming
   * errors, so they come back as a result rather than a thrown error.
   * Calling `restart()` from any state other than `Crashed` is a
   * programming error and does throw.
   */
  restart(): RealmRestartOutcome {
    this.#assertState('restart', ['crashed']);
    if (!this.#dependencies.isReferenced()) {
      return { ok: false, reason: 'unreferenced' };
    }
    if (this.#restartCount >= this.#dependencies.maxRestarts) {
      return { ok: false, reason: 'restart-budget-exceeded' };
    }
    this.#restartCount += 1;
    this.#transitionTo('warming');
    return { ok: true };
  }

  #assertState(action: string, allowed: readonly RealmLifecycleState[]): void {
    if (!allowed.includes(this.#state)) {
      throw new RealmLifecycleTransitionError(action, this.#state);
    }
  }

  #transitionTo(to: RealmLifecycleState): void {
    const from = this.#state;
    this.#state = to;
    for (const listener of this.#listeners) {
      listener({ from, to });
    }
  }
}
