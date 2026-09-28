/**
 * Real Bun-`Bun.spawn`-IPC-backed revision realm (COR-246).
 *
 * Implements the exact same {@link
 * import('./revision-realm.ts').RevisionRealm} port `WorkerRealm` (COR-249)
 * implements — `activate`, `dispatchTurn`, `beginDrain`, `terminate`,
 * `crash`, `restart` — driven by the identical transport-independent {@link
 * RealmLifecycle} and {@link import('./realm-protocol.ts').RealmTurnEnvelope}
 * modules R1 (COR-117) built and proved against the fake realm, and R2
 * (COR-249) proved again against a real `Worker`. Where `WorkerRealm` settles
 * in response to `postMessage` events crossing a `Worker` thread boundary,
 * `ChildProcessRealm` settles in response to `Bun.spawn`'s own IPC channel —
 * the realm-ready handshake ({@link
 * import('../worker-realm-readiness.ts').WorkerRealmReadyMessage}) and the
 * shared `realm-run` / `realm-result` / `realm-failure` wire messages
 * ({@link import('./worker-realm-messages.ts')}) travel over `subprocess.send`
 * / `process.send` instead of `postMessage`.
 *
 * A child process is a stronger crash/resource boundary than a Worker's
 * shared-process heap: a realm that segfaults, leaks native memory, or hangs
 * the event loop cannot corrupt the host's own process the way a Worker
 * thread sharing the host's address space theoretically could, at the cost
 * of a real OS process per realm rather than a thread. Bun's IPC channel
 * (`ipc`) is only compatible with another `bun` instance as the child — see
 * `#spawnProcess` — so `scriptPath` must be a script this same Bun binary can
 * run, exactly like `workerUrl` names a script `new Worker()` can run.
 *
 * One `ChildProcessRealm` instance serves exactly one execution's entire
 * turn sequence, from `activate()` through completion — the same
 * one-generation, fixed-`executionToken` model `FakeRealm` and `WorkerRealm`
 * both already implement (see `worker-realm.ts`'s own module doc). A
 * `RevisionRealmPool` selects this adapter over `WorkerRealm` per
 * `RevisionRealmConfig.transport === 'child-process'`; the default transport
 * (`'worker'`, or `transport` omitted) is unchanged.
 *
 * `RealmLifecycle`'s transition table has no direct path to `Terminated`
 * except through `Draining`, and no exit at all from `Warming` other than
 * `markReady`. `#forceDown` routes a real process failure, or a pool
 * discarding a realm it never activated, through the nearest legal exit —
 * see `WorkerRealm`'s own doc for the identical reasoning — rather than
 * reopening that transition table.
 *
 * @module core/realm/child-process-realm
 */

import { fileURLToPath } from 'node:url';

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
import type { RevisionRealmActivation } from './revision-realm.ts';
import {
  isRealmFailureMessage,
  isRealmResultMessage,
  type RealmRunMessage,
} from './worker-realm-messages.ts';

type PendingOutcome = { kind: 'success'; result: unknown } | { kind: 'failure'; error: string };

interface PendingChildProcessTurn {
  readonly envelope: RealmTurnEnvelope;
  settle: ((outcome: PendingOutcome) => void) | null;
}

export interface ChildProcessRealmOptions extends RealmLifecycleDependencies {
  /** The bootstrap script the spawned child process runs. Must be runnable by this same Bun binary — see the module doc for why. */
  readonly scriptPath: string | URL;
  readonly expectedWorkflowTypes: readonly string[];
  /** Opt-in revision digest check (COR-117's `getExpectedArtifactDigest`) — a revision realm always supplies this, so two revisions of the same workflow TYPE name cannot be confused for one another. */
  readonly expectedArtifactDigest?: string;
  readonly realmReadyTimeoutMs?: number;
  readonly maxProtocolMessageBytes?: number;
  /**
   * Sent as the `artifactDigest` field of the `realm-configure` message
   * `#spawnProcess` always sends immediately after spawning, before the
   * realm-ready handshake. A production bootstrap script is free to ignore
   * this message entirely and derive its identity from its own bundled
   * build (one `scriptPath` per revision); test bootstraps use it to
   * advertise a revision-specific identity from one shared fixture script.
   */
  readonly workerName?: string;
  /**
   * Explicit environment for the spawned process. Omitted means Bun's own
   * default (inherit this process's environment) — the same default
   * behavior as before this option existed, kept explicit here as one of
   * this adapter's "resource boundary" knobs (the coordinator's own
   * language) rather than an unstated assumption.
   */
  readonly env?: Readonly<Record<string, string>>;
}

const DEFAULT_REALM_READY_TIMEOUT_MS = 5_000;

/** Resolved once a {@link ChildProcessRealm}'s current child process has actually exited — see {@link ChildProcessRealm.whenReclaimed}. */
export interface ChildProcessReclamation {
  readonly pid: number;
  readonly exitCode: number | null;
}

/**
 * One real `Bun.spawn`-IPC-backed revision realm. See the module doc for the
 * one-realm-one-execution model and how this relates to `FakeRealm` and
 * `WorkerRealm`.
 */
export class ChildProcessRealm {
  readonly lifecycle: RealmLifecycle;
  readonly #options: ChildProcessRealmOptions;
  readonly #pendingTurns = new Map<number, PendingChildProcessTurn>();
  #process: Subprocess;
  /**
   * True once `.kill()` has been sent to the CURRENT `#process` instance
   * (COR-113), mirroring `WorkerRealm`'s `#workerTerminated`. Deliberately
   * independent of `lifecycle.state` for the identical reason documented
   * there: a rejected ready handshake moves `lifecycle.state` straight to
   * `crashed` via `markReady` in `#handleMessage`, before anything has told
   * the underlying process to stop. Reset by `#spawnProcess()` (constructor
   * and `restart()`) for each fresh process instance.
   */
  #processTerminated = false;
  /**
   * Incremented at the start of every `#spawnProcess()` call and captured by
   * that call's own `onExit`/`onDisconnect` closures, so a stale exit event
   * from a process `restart()` already replaced — reported asynchronously,
   * possibly after `lifecycle` has moved off its terminal state — cannot run
   * `#handleProcessDown()` against the NEW process. `onDisconnect` takes no
   * argument to compare against `this.#process` directly, so an epoch is
   * compared instead.
   */
  #spawnEpoch = 0;
  #activation: RevisionRealmActivation | null = null;
  #nextExpectedTurnId = 1;
  #readyOutcome: RealmReadyOutcome | null = null;
  #readyWaiters: ((outcome: RealmReadyOutcome) => void)[] = [];
  #readyTimeout: ReturnType<typeof setTimeout> | null = null;

  constructor(options: ChildProcessRealmOptions) {
    this.#options = options;
    this.lifecycle = new RealmLifecycle(options);
    this.#process = this.#spawnProcess();
  }

  /** See `WorkerRealm.waitUntilReady`'s identical doc. */
  async waitUntilReady(): Promise<RealmReadyOutcome> {
    if (this.#readyOutcome) return this.#readyOutcome;
    return new Promise((resolve) => {
      this.#readyWaiters.push(resolve);
      this.#readyTimeout ??= setTimeout(() => {
        if (this.#readyOutcome) return;
        this.lifecycle.markReady({ ok: false });
        this.#settleReady({
          ok: false,
          error: `Child-process realm did not send a ready message within ${this.#options.realmReadyTimeoutMs ?? DEFAULT_REALM_READY_TIMEOUT_MS}ms`,
          failureCategory: 'timeout',
        });
      }, this.#options.realmReadyTimeoutMs ?? DEFAULT_REALM_READY_TIMEOUT_MS);
    });
  }

  /** `Ready` -> `Active`. See `WorkerRealm.activate`. */
  activate(activation: RevisionRealmActivation): void {
    this.lifecycle.activate();
    this.#activation = activation;
    this.#nextExpectedTurnId = 1;
  }

  /**
   * Dispatch one turn over the real child process's IPC channel. Same
   * envelope-fencing rules as `WorkerRealm.dispatchTurn` and
   * `FakeRealm.dispatchTurn`: rejects immediately, with no pending turn
   * created, when not `Active` or the envelope disagrees with the fixed
   * activation identifiers or the next expected `turnId`.
   */
  dispatchTurn(envelope: RealmTurnEnvelope, input: unknown): Promise<unknown> {
    if (this.lifecycle.state !== 'active' || this.#activation === null) {
      return Promise.reject(
        new Error(`Child-process realm cannot accept a turn while ${this.lifecycle.state}`),
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
      this.#process.send(message);
    });
  }

  /** `Active` -> `Draining`. No new turn may be dispatched afterward. */
  beginDrain(): void {
    this.lifecycle.beginDrain();
  }

  /**
   * `Draining` -> `Terminated`, rejecting every turn still pending, and
   * killing the underlying child process. Idempotent (COR-113) on the same
   * terms as `WorkerRealm.terminate`.
   */
  terminate(): void {
    if (!this.#isTerminalState()) {
      this.lifecycle.terminate();
      this.#settlePendingTurns();
    }
    this.#terminateProcessOnce();
  }

  /**
   * Crash the realm: settles every pending turn with a rejection and kills
   * the underlying child process. Idempotent (COR-113) on the same terms as
   * {@link terminate}.
   */
  crash(): void {
    if (!this.#isTerminalState()) {
      this.lifecycle.crash();
      this.#settlePendingTurns();
    }
    this.#terminateProcessOnce();
  }

  /**
   * Bounded `Crashed` -> `Warming` restart. A fresh child process replaces
   * the crashed one — the old one cannot be trusted to still be alive or
   * uncorrupted — while this `ChildProcessRealm` instance and its
   * `RealmLifecycle` (including `restartCount`) are reused, matching
   * `WorkerRealm.restart`'s identical same-instance model.
   */
  restart(): RealmRestartOutcome {
    const outcome = this.lifecycle.restart();
    if (outcome.ok) {
      this.#readyOutcome = null;
      this.#processTerminated = false;
      this.#process = this.#spawnProcess();
    }
    return outcome;
  }

  /**
   * Force this realm down regardless of its current state. See
   * `WorkerRealm.discard`'s identical doc.
   */
  discard(): void {
    if (!this.#isTerminalState()) {
      this.#forceDown();
    }
    this.#terminateProcessOnce();
  }

  /** The activation identifiers fixed for this realm's current `Active` lifetime, or `null` before `activate()` (or after a crash/restart cleared it). */
  get activation(): RevisionRealmActivation | null {
    return this.#activation;
  }

  get pendingTurnCount(): number {
    return this.#pendingTurns.size;
  }

  /** The current child process's OS process id — an observability/test seam, never consulted by production dispatch logic. */
  get pid(): number {
    return this.#process.pid;
  }

  /**
   * Resolves once this realm's CURRENT child process has actually exited —
   * "prove child exit releases the process" via an observed OS-level event,
   * not `kill()`'s own void return. Combine with `process.kill(pid, 0)`
   * (throws `ESRCH` once reclaimed) and `postRawMessageForTesting` (throws
   * once the IPC channel is closed) to observe both halves — see
   * `child-process-realm.test.ts`.
   */
  async whenReclaimed(): Promise<ChildProcessReclamation> {
    const childProcess = this.#process;
    const exitCode = await childProcess.exited;
    return { pid: childProcess.pid, exitCode };
  }

  /**
   * Internal test seam: send a raw message directly to the underlying child
   * process, bypassing `dispatchTurn`'s envelope machinery entirely. Mirrors
   * `WorkerRealm.postRawMessageForTesting` — used by fixture-process tests to
   * send the `test-release`/`test-fail` control messages the child-process
   * fixtures understand. Never called from production code.
   */
  postRawMessageForTesting(message: unknown): void {
    this.#process.send(message);
  }

  /**
   * Internal test seam: feed a message directly into this realm's OWN
   * inbound message handling, as if it had just arrived over the IPC
   * channel from the real child process — the opposite direction of {@link
   * postRawMessageForTesting}. Mirrors `WorkerRealm.receiveRealmMessageForTesting`'s
   * identical doc and purpose. Never called from production code.
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
          error: 'Child-process realm went down before completing its ready handshake',
          failureCategory: 'system',
        });
        return;
      case 'ready':
        // `Ready` has no direct `Terminated` exit -- `Terminated` is
        // reachable only through `Draining` -- so an idle, never-activated
        // realm is always reclaimed through `crash()`, matching
        // `WorkerRealm#forceDown`.
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

  #spawnProcess(): Subprocess {
    const spawnEpoch = ++this.#spawnEpoch;
    const scriptPath =
      typeof this.#options.scriptPath === 'string'
        ? this.#options.scriptPath
        : fileURLToPath(this.#options.scriptPath);
    const child = Bun.spawn({
      cmd: [process.execPath, scriptPath],
      // Bun IPC only speaks to another `bun` instance -- see the module doc.
      ipc: (message) => {
        void this.#handleMessage(message).catch(() => {});
      },
      onExit: () => {
        if (spawnEpoch !== this.#spawnEpoch) return;
        this.#handleProcessDown();
      },
      onDisconnect: () => {
        if (spawnEpoch !== this.#spawnEpoch) return;
        this.#handleProcessDown();
      },
      serialization: 'advanced',
      stdin: 'ignore',
      // Explicit rather than Bun's own `'pipe'` default: an unread stdout/
      // stderr pipe fills its OS buffer and blocks the child indefinitely --
      // a real resource-boundary hazard this adapter's own tests would
      // otherwise hang on the instant a fixture writes anything to either
      // stream.
      stdout: 'inherit',
      stderr: 'inherit',
      ...(this.#options.env === undefined ? {} : { env: this.#options.env }),
    });
    // See `WorkerRealm#spawnWorker`'s identical doc for why this is sent as
    // a message rather than derived from a spawn option: a shared test
    // fixture script needs a real, message-based way to learn which
    // revision it should simulate. A production bootstrap script has no use
    // for this message (it already knows its own identity from its own
    // build) and simply ignores it if its script never listens for the type.
    const configureMessage: { type: 'realm-configure'; artifactDigest?: string } = {
      type: 'realm-configure',
      ...(this.#options.workerName === undefined
        ? {}
        : { artifactDigest: this.#options.workerName }),
    };
    child.send(configureMessage);
    return child;
  }

  /**
   * Routes both a genuine child-process failure AND this realm's own
   * self-initiated `kill()` through one path, mirroring
   * `WorkerRealm#handleWorkerFailure`. Unlike a real `Worker`'s `error`
   * event (which never fires merely because `.terminate()` was called),
   * `onExit`/`onDisconnect` fire for EVERY exit of an IPC child process,
   * including one this realm itself just killed via `#terminateProcessOnce`
   * -- `#isTerminalState()` is what makes that call a no-op instead of a
   * double `#forceDown()`. `onExit` and `onDisconnect` have no guaranteed
   * firing order (Bun's own documented behavior) and either may arrive
   * first or run alone in a given exit; both funnel here so ordering never
   * matters.
   */
  #handleProcessDown(): void {
    if (!this.#isTerminalState()) {
      this.#forceDown();
    }
    this.#terminateProcessOnce();
  }

  /** See `WorkerRealm#isTerminalState`'s identical doc. */
  #isTerminalState(): boolean {
    return this.lifecycle.state === 'terminated' || this.lifecycle.state === 'crashed';
  }

  /**
   * Send `.kill()` to the current `#process` at most once (COR-113). Every
   * shutdown path (`terminate`/`crash`/`discard`/a real process failure)
   * funnels through this instead of calling `this.#process.kill()`
   * directly, mirroring `WorkerRealm#terminateWorkerOnce`'s identical
   * reasoning.
   */
  #terminateProcessOnce(): void {
    if (this.#processTerminated) return;
    this.#processTerminated = true;
    this.#process.kill();
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

  /** See `WorkerRealm#acceptRealmMessage`'s identical doc. */
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

/**
 * Local alias for Bun's own `Subprocess` type, narrowed to the stdio shape
 * this realm always spawns with (`stdin: 'ignore'`, `stdout`/`stderr:
 * 'inherit'`), matching `src/testing/subprocess-lifecycle.ts`'s identical
 * `RunningSubprocess` convention for the same reason.
 */
type Subprocess = Bun.Subprocess<'ignore', 'inherit', 'inherit'>;
