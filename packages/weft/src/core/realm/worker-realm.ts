/**
 * Real Worker-backed revision realm (COR-249).
 *
 * Implements the same port {@link
 * import('./fake-realm.test-support.ts').FakeRealm} exposes — `activate`,
 * `dispatchTurn`, `beginDrain`, `terminate`, `crash`, `restart` — over an
 * actual Bun `Worker`, driven by the same transport-independent {@link
 * RealmLifecycle} and {@link
 * import('./realm-protocol.ts').RealmTurnEnvelope} modules R1 (COR-117)
 * built and proved against the fake realm. Where `FakeRealm` settles
 * synchronously in response to a direct method call, `WorkerRealm` settles
 * in response to real `postMessage` events crossing an actual Worker
 * boundary — the realm-ready handshake ({@link
 * import('../worker-realm-readiness.ts').WorkerRealmReadyMessage}) and this
 * module's own `realm-run` / `realm-result` / `realm-failure` wire messages
 * ({@link import('./worker-realm-messages.ts')}).
 *
 * One `WorkerRealm` instance serves exactly one execution's entire turn
 * sequence, from `activate()` through completion — the same
 * one-generation, fixed-`executionToken` model `FakeRealm` defines (see its
 * own module doc: "`activation` fixes the three per-generation identifiers
 * every subsequent turn is checked against"). A `RevisionRealmPool`
 * (COR-249) is what warms several `WorkerRealm` instances for one immutable
 * revision and hands one out per execution.
 *
 * `RealmLifecycle`'s transition table has no direct path to `Terminated`
 * except through `Draining`, and no exit at all from `Warming` other than
 * `markReady`. `#forceDown` routes a real Worker failure, or a pool
 * discarding a realm it never activated, through the nearest legal exit —
 * see its own doc — rather than reopening that transition table.
 *
 * @module core/realm/worker-realm
 */

import {
  isWorkerRealmReadyMessage,
  validateRealmReadyMessage,
  type RealmReadyOutcome,
} from '../worker-realm-readiness.ts';
import {
  RealmLifecycle,
  type RealmLifecycleDependencies,
  type RealmRestartOutcome,
} from './realm-lifecycle.ts';
import { validateRealmTurnEnvelope, type RealmTurnEnvelope } from './realm-protocol.ts';
import {
  isRealmFailureMessage,
  isRealmResultMessage,
  type RealmRunMessage,
} from './worker-realm-messages.ts';

/** Activation identifiers fixed for a {@link WorkerRealm}'s entire `Active` lifetime. See {@link WorkerRealm.activate}. */
export interface WorkerRealmActivation {
  readonly workflowRevision: string;
  readonly realmGeneration: string;
  readonly executionToken: string;
}

type PendingOutcome = { kind: 'success'; result: unknown } | { kind: 'failure'; error: string };

interface PendingWorkerTurn {
  readonly envelope: RealmTurnEnvelope;
  settle: ((outcome: PendingOutcome) => void) | null;
}

export interface WorkerRealmOptions extends RealmLifecycleDependencies {
  readonly workerUrl: string | URL;
  readonly expectedWorkflowTypes: readonly string[];
  /** Opt-in revision digest check (COR-117's `getExpectedArtifactDigest`) — a revision realm always supplies this, so two revisions of the same workflow TYPE name cannot be confused for one another. */
  readonly expectedArtifactDigest?: string;
  readonly realmReadyTimeoutMs?: number;
  readonly maxProtocolMessageBytes?: number;
  /**
   * Sent as the `artifactDigest` field of the `realm-configure` message
   * `#spawnWorker` always posts immediately after spawning, before the
   * realm-ready handshake. A production bootstrap script is free to ignore
   * this message entirely and derive its identity from its own bundled
   * build (one `workerUrl` per revision); test bootstraps use it to
   * advertise a revision-specific identity from one shared fixture script.
   */
  readonly workerName?: string;
  readonly smol?: boolean;
}

const DEFAULT_REALM_READY_TIMEOUT_MS = 5_000;

/**
 * One real Worker-backed revision realm. See the module doc for the
 * one-realm-one-execution model and how this relates to `FakeRealm`.
 */
export class WorkerRealm {
  readonly lifecycle: RealmLifecycle;
  readonly #options: WorkerRealmOptions;
  readonly #pendingTurns = new Map<number, PendingWorkerTurn>();
  #worker: Worker;
  /**
   * True once `.terminate()` has been sent to the CURRENT `#worker` instance
   * (COR-113). Deliberately independent of `lifecycle.state`: a rejected
   * ready handshake moves `lifecycle.state` straight to `crashed` via
   * `markReady` in `#handleMessage`, before anything has told the underlying
   * Worker thread to stop — `discard()` is what a caller uses to reclaim
   * that leaked thread afterward, and it must still send `.terminate()` even
   * though the lifecycle is already terminal. Reset by `#spawnWorker()`
   * (constructor and `restart()`) for each fresh Worker instance.
   */
  #workerTerminated = false;
  #activation: WorkerRealmActivation | null = null;
  #nextExpectedTurnId = 1;
  #readyOutcome: RealmReadyOutcome | null = null;
  #readyWaiters: ((outcome: RealmReadyOutcome) => void)[] = [];
  #readyTimeout: ReturnType<typeof setTimeout> | null = null;
  /**
   * Resolves once the CURRENT `#worker`'s real `close` event fires (COR-246:
   * "prove ... Worker termination releases its handle" via an observed
   * OS/thread-level event, not by inferring reclamation from
   * `worker.terminate()`'s own void return). Reassigned by `#spawnWorker()`
   * for each fresh Worker instance, mirroring `#worker` itself.
   */
  #closePromise!: Promise<void>;

  constructor(options: WorkerRealmOptions) {
    this.#options = options;
    this.lifecycle = new RealmLifecycle(options);
    this.#worker = this.#spawnWorker();
  }

  /**
   * Resolves once the realm's one-time `ready` handshake settles — `Ready`
   * on success, `Crashed` on a rejected manifest/digest, or a timeout.
   * Mirrors {@link
   * import('../worker-realm-readiness.ts').WorkerRealmReadiness.waitForReady}
   * for a single realm instance rather than a pool of interchangeable
   * workers.
   */
  async waitUntilReady(): Promise<RealmReadyOutcome> {
    if (this.#readyOutcome) return this.#readyOutcome;
    return new Promise((resolve) => {
      this.#readyWaiters.push(resolve);
      this.#readyTimeout ??= setTimeout(() => {
        // `#readyOutcome` may already be set if a real `ready`/error message
        // settled this realm in the same tick this timer was scheduled to
        // fire — `#settleReady` below is a no-op in that case, but the
        // lifecycle transition must not double-fire either, so it is
        // guarded the same way.
        if (this.#readyOutcome) return;
        this.lifecycle.markReady({ ok: false });
        this.#settleReady({
          ok: false,
          error: `Worker realm did not send a ready message within ${this.#options.realmReadyTimeoutMs ?? DEFAULT_REALM_READY_TIMEOUT_MS}ms`,
          failureCategory: 'timeout',
        });
      }, this.#options.realmReadyTimeoutMs ?? DEFAULT_REALM_READY_TIMEOUT_MS);
    });
  }

  /** `Ready` -> `Active`. See {@link import('./fake-realm.test-support.ts').FakeRealm.activate}. */
  activate(activation: WorkerRealmActivation): void {
    this.lifecycle.activate();
    this.#activation = activation;
    this.#nextExpectedTurnId = 1;
  }

  /**
   * Dispatch one turn over the real Worker's `postMessage`. Same
   * envelope-fencing rules as {@link
   * import('./fake-realm.test-support.ts').FakeRealm.dispatchTurn}: rejects
   * immediately, with no pending turn created, when not `Active` or the
   * envelope disagrees with the fixed activation identifiers or the next
   * expected `turnId`.
   */
  dispatchTurn(envelope: RealmTurnEnvelope, input: unknown): Promise<unknown> {
    if (this.lifecycle.state !== 'active' || this.#activation === null) {
      return Promise.reject(
        new Error(`Worker realm cannot accept a turn while ${this.lifecycle.state}`),
      );
    }

    const expected: RealmTurnEnvelope = { ...this.#activation, turnId: this.#nextExpectedTurnId };
    const validation = validateRealmTurnEnvelope(expected, envelope);
    if (!validation.ok) {
      return Promise.reject(
        new Error(
          `Realm turn envelope mismatch on ${validation.mismatch}: expected ${String(validation.expected)}, received ${String(validation.received)}`,
        ),
      );
    }

    this.#nextExpectedTurnId += 1;
    return new Promise((resolve, reject) => {
      this.#pendingTurns.set(envelope.turnId, {
        envelope,
        settle: (outcome) => {
          if (outcome.kind === 'success') resolve(outcome.result);
          else reject(new Error(outcome.error));
        },
      });
      const message: RealmRunMessage = { type: 'realm-run', envelope, input };
      this.#worker.postMessage(message);
    });
  }

  /** `Active` -> `Draining`. No new turn may be dispatched afterward. */
  beginDrain(): void {
    this.lifecycle.beginDrain();
  }

  /**
   * `Draining` -> `Terminated`, rejecting every turn still pending, and
   * terminating the underlying Worker thread. Idempotent (COR-113): a no-op
   * once this realm has already reached `Terminated` or `Crashed` by any
   * path (an earlier `terminate()`/`crash()`/`discard()` call, or a real
   * Worker failure) — a repeated or racing close signal must never throw
   * `RealmLifecycleTransitionError`, re-settle already-empty pending turns,
   * or terminate the underlying Worker a second time.
   */
  terminate(): void {
    if (!this.#isTerminalState()) {
      this.lifecycle.terminate();
      this.#settlePendingTurns();
    }
    this.#terminateWorkerOnce();
  }

  /**
   * Crash the realm: settles every pending turn with a rejection and
   * terminates the underlying Worker thread. Idempotent (COR-113) on the
   * same terms as {@link terminate}.
   */
  crash(): void {
    if (!this.#isTerminalState()) {
      this.lifecycle.crash();
      this.#settlePendingTurns();
    }
    this.#terminateWorkerOnce();
  }

  /**
   * Bounded `Crashed` -> `Warming` restart. A fresh `Worker` replaces the
   * crashed one — the old thread cannot be trusted to still be alive or
   * uncorrupted — while this `WorkerRealm` instance and its `RealmLifecycle`
   * (including `restartCount`) are reused, matching {@link
   * import('./fake-realm.test-support.ts').FakeRealm.restart}'s
   * same-instance model.
   */
  restart(): RealmRestartOutcome {
    const outcome = this.lifecycle.restart();
    if (outcome.ok) {
      this.#readyOutcome = null;
      this.#workerTerminated = false;
      this.#worker = this.#spawnWorker();
    }
    return outcome;
  }

  /**
   * Force this realm down regardless of its current state, for a pool
   * discarding a realm it warmed but never activated, or as part of overall
   * pool shutdown. Ends in `Crashed` (from `Warming`/`Ready`, which have no
   * `Terminated` exit) or `Terminated` (from `Active`/`Draining`, via a
   * graceful drain first) — see the module doc. Idempotent (COR-113) on the
   * same terms as {@link terminate}: a no-op once already `Terminated` or
   * `Crashed`.
   */
  discard(): void {
    if (!this.#isTerminalState()) {
      this.#forceDown();
    }
    this.#terminateWorkerOnce();
  }

  /** The activation identifiers fixed for this realm's current `Active` lifetime, or `null` before `activate()` (or after a crash/restart cleared it). */
  get activation(): WorkerRealmActivation | null {
    return this.#activation;
  }

  get pendingTurnCount(): number {
    return this.#pendingTurns.size;
  }

  /**
   * Resolves once this realm's CURRENT underlying Worker thread has actually
   * shut down. See `#closePromise`'s own doc, and `child-process-realm.ts`'s
   * `whenReclaimed` for the analogous child-process-side proof.
   */
  async whenReclaimed(): Promise<void> {
    return this.#closePromise;
  }

  /**
   * Internal test seam: post a raw message directly to the underlying real
   * Worker, bypassing `dispatchTurn`'s envelope machinery entirely. Used by
   * fixture-worker tests to send the `test-release`/`test-fail` control
   * messages {@link
   * import('./__fixtures__/revision-realm-worker-entry.ts')} understands —
   * messages no production bootstrap or host ever sends. Never called from
   * production code.
   */
  postRawMessageForTesting(message: unknown): void {
    this.#worker.postMessage(message);
  }

  /**
   * Internal test seam: feed a message directly into this realm's OWN
   * inbound message handling, as if it had just arrived over `postMessage`
   * from the real Worker — the opposite direction of {@link
   * postRawMessageForTesting}. Lets `realm-conformance.test.ts` exercise the
   * host-side envelope fencing on an INCOMING `realm-result`/`realm-failure`
   * message directly (a deliberately mismatched envelope, an arbitrary
   * result value) without depending on a specific fixture script's own
   * echo behavior to produce it. Never called from production code.
   */
  async receiveRealmMessageForTesting(message: unknown): Promise<void> {
    return this.#handleMessage(message);
  }

  #forceDown(): void {
    switch (this.lifecycle.state) {
      case 'warming':
        this.lifecycle.markReady({ ok: false });
        this.#settleReady({
          ok: false,
          error: 'Worker realm went down before completing its ready handshake',
          failureCategory: 'system',
        });
        return;
      case 'ready':
        // `Ready` has no direct `Terminated` exit — `Terminated` is reachable
        // only through `Draining` — so an idle, never-activated realm is
        // always reclaimed through `crash()`.
        this.lifecycle.crash();
        break;
      case 'active':
        this.lifecycle.beginDrain();
        this.lifecycle.terminate();
        break;
      case 'draining':
        this.lifecycle.terminate();
        break;
      default:
        break;
    }
    this.#settlePendingTurns();
  }

  #spawnWorker(): Worker {
    const workerOptions: WorkerOptions & { smol?: boolean } = {};
    if (this.#options.smol) workerOptions.smol = true;
    const worker = new Worker(this.#options.workerUrl, workerOptions);
    this.#closePromise = new Promise((resolve) => {
      worker.addEventListener('close', () => resolve(), { once: true });
    });
    worker.addEventListener('message', (event: MessageEvent) => {
      void this.#handleMessage(event.data).catch(() => {});
    });
    worker.addEventListener('error', () => {
      this.#handleWorkerFailure();
    });
    worker.addEventListener('messageerror', () => {
      this.#handleWorkerFailure();
    });
    // `WorkerOptions.name` is part of the Worker spec but Bun does not
    // surface it as the spawned worker's own `self.name` (verified against
    // Bun 1.4.2), so a test fixture cannot rely on it to learn which
    // revision it should simulate. Sending an explicit `realm-configure`
    // message as the very first thing this realm ever posts — before the
    // realm-ready handshake, before any turn — gives a shared test fixture
    // script a real, message-based way to learn its digest instead. A
    // production bootstrap script has no use for this message (it already
    // knows its own identity from its own build) and simply ignores it if
    // its script never listens for the type.
    const configureMessage: { type: 'realm-configure'; artifactDigest?: string } = {
      type: 'realm-configure',
      ...(this.#options.workerName === undefined
        ? {}
        : { artifactDigest: this.#options.workerName }),
    };
    worker.postMessage(configureMessage);
    return worker;
  }

  #handleWorkerFailure(): void {
    if (!this.#isTerminalState()) {
      this.#forceDown();
    }
    this.#terminateWorkerOnce();
  }

  /**
   * True once this realm's LIFECYCLE has reached a terminal disposal state
   * (`Terminated` or `Crashed`) by any path. Guards the lifecycle-transition
   * half of every shutdown entry point so a repeated or racing close/crash
   * signal never throws `RealmLifecycleTransitionError` for a transition
   * that already happened (COR-113). Deliberately NOT what gates the
   * underlying `Worker.terminate()` call — see `#terminateWorkerOnce`'s doc
   * and `#workerTerminated`'s doc for why those are a separate concern. A
   * `restart()` from `Crashed` moves the state back to `Warming`, so this
   * correctly becomes `false` again for a fresh cycle on the same instance.
   */
  #isTerminalState(): boolean {
    return this.lifecycle.state === 'terminated' || this.lifecycle.state === 'crashed';
  }

  /**
   * Send `.terminate()` to the current `#worker` at most once (COR-113).
   * Every shutdown path (`terminate`/`crash`/`discard`/a real Worker
   * failure) funnels through this instead of calling `this.#worker
   * .terminate()` directly, so two of them racing — or one running after the
   * lifecycle already went terminal via `#handleMessage`'s ready-handshake
   * rejection, which never itself terminates the Worker — still terminate
   * the real underlying thread exactly once rather than zero or two times.
   */
  #terminateWorkerOnce(): void {
    if (this.#workerTerminated) return;
    this.#workerTerminated = true;
    this.#worker.terminate();
  }

  async #handleMessage(message: unknown): Promise<void> {
    if (isWorkerRealmReadyMessage(message)) {
      const outcome = await validateRealmReadyMessage(message, {
        getExpectedWorkflowTypes: () => this.#options.expectedWorkflowTypes,
        maxProtocolMessageBytes: this.#options.maxProtocolMessageBytes,
        getExpectedArtifactDigest: () => this.#options.expectedArtifactDigest,
      });
      this.lifecycle.markReady({ ok: outcome.ok });
      this.#settleReady(outcome);
      return;
    }

    if (isRealmResultMessage(message)) {
      this.#acceptRealmMessage(message.envelope, { kind: 'success', result: message.result });
      return;
    }

    if (isRealmFailureMessage(message)) {
      this.#acceptRealmMessage(message.envelope, { kind: 'failure', error: message.error });
    }
  }

  /**
   * Apply a realm-to-host message for `envelope.turnId`. Silently dropped
   * (not applied, not thrown) when the realm is not `Active` — nothing
   * pending can be legitimately settled by a drained/terminated/crashed
   * realm, "a drained realm ... cannot emit an accepted late result" — when
   * no pending turn matches `envelope.turnId`, or when `envelope` disagrees
   * with the specific pending turn's own stored envelope (not merely its
   * `turnId`): a stale or misrouted message must never resolve someone
   * else's still-outstanding turn. There is no synchronous caller here to
   * throw back to (unlike {@link
   * import('./fake-realm.test-support.ts').FakeRealm.acceptResult}), so a
   * fenced mismatch is a no-op rather than a thrown
   * `RealmEnvelopeMismatchError` — the real, still-outstanding pending turn
   * is left untouched either way.
   */
  #acceptRealmMessage(envelope: RealmTurnEnvelope, outcome: PendingOutcome): void {
    if (this.lifecycle.state !== 'active') return;
    const pending = this.#pendingTurns.get(envelope.turnId);
    if (!pending || !pending.settle) return;
    const validation = validateRealmTurnEnvelope(pending.envelope, envelope);
    if (!validation.ok) return;

    const settle = pending.settle;
    pending.settle = null;
    this.#pendingTurns.delete(envelope.turnId);
    settle(outcome);
  }

  #settleReady(outcome: RealmReadyOutcome): void {
    if (this.#readyOutcome) return;
    this.#readyOutcome = outcome;
    if (this.#readyTimeout) {
      clearTimeout(this.#readyTimeout);
      this.#readyTimeout = null;
    }
    const waiters = this.#readyWaiters.splice(0);
    for (const waiter of waiters) waiter(outcome);
  }

  #settlePendingTurns(): void {
    for (const [turnId, pending] of this.#pendingTurns) {
      const settle = pending.settle;
      pending.settle = null;
      settle?.({ kind: 'failure', error: `Turn ${turnId} was not accepted: realm-not-active` });
      this.#pendingTurns.delete(turnId);
    }
  }
}
