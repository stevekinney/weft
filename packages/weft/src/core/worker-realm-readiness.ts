/**
 * Realm-ready handshake for internal `workflowExecutionMode: 'worker'`
 * Workers (WFT-28).
 *
 * An internal Worker realm sends a `ready` message — its own manifest, built
 * from exactly the workflow types its bootstrap script registered — before
 * it can receive a `run` turn. The host checks that every workflow type it
 * has registered appears in that manifest with a matching contract (a
 * subset check, not exact-set equality — a realm may legitimately advertise
 * more types than any one host dispatches to it, e.g. a shared worker pool
 * serving several engines). A missing or mismatched type means the realm's
 * bundle disagrees with the host about a workflow it needs (a stale build, a
 * bootstrap script that fell out of sync), and the realm is discarded before
 * it can ever execute a turn, rather than failing opaquely mid-dispatch.
 *
 * `ready` has no `workflowId` — it is a per-worker-lifetime handshake, not a
 * per-workflow-turn message — so it cannot fit {@link WorkerOutboundMessage}'s
 * shape (every variant there requires one) and is validated on its own path
 * instead of through {@link assertWorkerOutboundMessageShape}, the same way
 * `log` is handled outside the strict turn gate.
 *
 * @module core/worker-realm-readiness
 */

import { computeWorkerManifestDigest, parseWorkerManifest } from '../worker/manifest/index.ts';
import {
  buildDeclaredWorkflowContract,
  declaredWorkflowContractsMatch,
} from '../worker/manifest/internal-realm.ts';
import type { WorkerManifest } from '../worker/manifest/types.ts';
import type { FailureCategory } from './types.ts';
import {
  assertWorkerProtocolMessageWithinLimit,
  WORKER_PROTOCOL_VERSION,
} from './worker-protocol.ts';

/** Sent once by a Worker realm, before its first `run` turn. See {@link WorkerRealmReadiness}. */
export type WorkerRealmReadyMessage = Readonly<{
  type: 'ready';
  protocolVersion: number;
  realmGeneration: string;
  manifest: WorkerManifest;
}>;

/** Shallow type guard — deep field validation happens in {@link WorkerRealmReadiness.noteReadyMessage}. */
export function isWorkerRealmReadyMessage(message: unknown): message is WorkerRealmReadyMessage {
  return (
    typeof message === 'object' &&
    message !== null &&
    (message as Record<string, unknown>)['type'] === 'ready'
  );
}

export type RealmReadyOutcome =
  | { ok: true; realmGeneration: string; manifestDigest: string }
  | { ok: false; error: string; failureCategory: FailureCategory };

export interface WorkerRealmReadinessDependencies {
  /**
   * Live accessor for the host's registered workflow types, called fresh on
   * every handshake rather than snapshotted at construction — the engine's
   * registrations map is still empty when the strategy is constructed (the
   * registration loop runs later in `Engine.create()`).
   */
  getExpectedWorkflowTypes: () => readonly string[];
  timeoutMs: number;
  maxProtocolMessageBytes: number | undefined;
}

/**
 * Tracks, per pooled `Worker` instance, whether its one-time ready handshake
 * has completed. A worker is validated at most once per lifetime — recycled
 * workers skip straight to {@link isReady}.
 */
export class WorkerRealmReadiness {
  readonly #dependencies: WorkerRealmReadinessDependencies;
  readonly #readyByWorker = new Map<Worker, { realmGeneration: string; manifestDigest: string }>();
  // At most one pending wait per worker: `WorkerPool` ownership guarantees a
  // worker is acquired by exactly one in-flight `acquireAndSend` at a time.
  readonly #pendingByWorker = new Map<Worker, (outcome: RealmReadyOutcome) => void>();

  constructor(dependencies: WorkerRealmReadinessDependencies) {
    this.#dependencies = dependencies;
  }

  isReady(worker: Worker): boolean {
    return this.#readyByWorker.has(worker);
  }

  /**
   * Wait for `worker`'s ready handshake. Resolves immediately if the worker
   * already completed it. The caller must attach its message listener (which
   * routes into {@link noteReadyMessage}) before calling this, in the same
   * synchronous continuation — `acquireAndSend` does exactly that, so no
   * `ready` message can arrive before this registers its pending waiter.
   */
  async waitForReady(worker: Worker): Promise<RealmReadyOutcome> {
    const known = this.#readyByWorker.get(worker);
    if (known) return { ok: true, ...known };

    return new Promise<RealmReadyOutcome>((resolve) => {
      let settled = false;
      const settleOnce = (outcome: RealmReadyOutcome): void => {
        if (settled) return;
        settled = true;
        resolve(outcome);
      };

      const timeout = setTimeout(() => {
        this.#pendingByWorker.delete(worker);
        settleOnce({
          ok: false,
          error: `Worker realm did not send a ready message within ${this.#dependencies.timeoutMs}ms`,
          failureCategory: 'timeout',
        });
      }, this.#dependencies.timeoutMs);

      this.#pendingByWorker.set(worker, (outcome) => {
        clearTimeout(timeout);
        settleOnce(outcome);
      });
    });
  }

  /** Validate an inbound `ready` message and settle any pending {@link waitForReady} call. */
  async noteReadyMessage(worker: Worker, message: unknown): Promise<void> {
    const outcome = await this.#validate(message);
    if (outcome.ok) {
      this.#readyByWorker.set(worker, {
        realmGeneration: outcome.realmGeneration,
        manifestDigest: outcome.manifestDigest,
      });
    }

    const pending = this.#pendingByWorker.get(worker);
    if (pending) {
      this.#pendingByWorker.delete(worker);
      pending(outcome);
    }
  }

  /** Drop a discarded worker's state, settling any pending waiter with a failure. */
  forget(worker: Worker): void {
    this.#readyByWorker.delete(worker);
    const pending = this.#pendingByWorker.get(worker);
    if (pending) {
      this.#pendingByWorker.delete(worker);
      pending({
        ok: false,
        error: 'Worker was discarded before its ready handshake completed',
        failureCategory: 'system',
      });
    }
  }

  /** Settle every pending waiter on strategy disposal so no wait hangs past teardown. */
  clear(): void {
    for (const resolve of this.#pendingByWorker.values()) {
      resolve({
        ok: false,
        error: 'Worker execution strategy was disposed before the ready handshake completed',
        failureCategory: 'system',
      });
    }
    this.#pendingByWorker.clear();
    this.#readyByWorker.clear();
  }

  async #validate(message: unknown): Promise<RealmReadyOutcome> {
    try {
      assertWorkerProtocolMessageWithinLimit(message, this.#dependencies.maxProtocolMessageBytes);
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        failureCategory: 'resource',
      };
    }

    const record = message as Record<string, unknown>;
    if (record['protocolVersion'] !== WORKER_PROTOCOL_VERSION) {
      return {
        ok: false,
        error: `Worker realm ready message protocol version mismatch: expected ${WORKER_PROTOCOL_VERSION}, got ${String(record['protocolVersion'])}`,
        failureCategory: 'system',
      };
    }

    if (typeof record['realmGeneration'] !== 'string' || record['realmGeneration'].length === 0) {
      return {
        ok: false,
        error: 'Worker realm ready message must include a non-empty realmGeneration string',
        failureCategory: 'system',
      };
    }

    const parsed = parseWorkerManifest(record['manifest']);
    if (!parsed.ok) {
      return {
        ok: false,
        error: `Worker realm manifest rejected: ${parsed.message}`,
        failureCategory: 'system',
      };
    }

    const missing = this.#dependencies
      .getExpectedWorkflowTypes()
      .filter((workflowType) => {
        const reported = parsed.manifest.workflows[workflowType];
        return (
          !reported ||
          !declaredWorkflowContractsMatch(reported, buildDeclaredWorkflowContract(workflowType))
        );
      })
      .toSorted();

    if (missing.length > 0) {
      return {
        ok: false,
        error: `Worker realm manifest is missing or disagrees on workflow type(s) the host expects: ${missing.join(', ')}`,
        failureCategory: 'system',
      };
    }

    const manifestDigest = await computeWorkerManifestDigest(parsed.manifest);
    return { ok: true, realmGeneration: record['realmGeneration'], manifestDigest };
  }
}
