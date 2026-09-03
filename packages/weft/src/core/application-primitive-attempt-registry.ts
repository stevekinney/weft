/**
 * The process-local registry of live claim attempts for one scope of an
 * application primitive (WFT-84, WFT-85), and the lease-commit serial that
 * fences reconciliation against it.
 *
 * Registrations live here rather than in durable storage because an
 * `AbortSignal` is process-local by construction; the registry is what lets a
 * cancellation, settlement, or maintenance pass in this process reach a
 * claimant in this process. Another process learns from renewal instead.
 *
 * @module core/application-primitive-attempt-registry
 */

import type { Storage } from '../storage/interface.ts';

/**
 * One live attempt in this process: its abort controller plus the callback that
 * forgets it from the handle that claimed it.
 *
 * Carrying the release alongside the controller is what lets a *sibling* handle
 * — one running maintenance, or settling with a token it was handed — release
 * ownership from the handle that actually owns it. Without that, the claiming
 * handle's ownership set leaks one entry per attempt settled elsewhere.
 */
export type AttemptRegistration = {
  readonly controller: AbortController;
  readonly release: () => void;
  /**
   * The subject (command, delivery) the attempt belongs to, so a caller-supplied
   * token cannot release another subject's attempt.
   */
  readonly subjectId: string;
  /**
   * The process-local lease-commit serial this attempt's lease landed under, or
   * `null` while its compare-and-swap is still in flight. A reconciliation from
   * a durable snapshot releases only attempts that committed BEFORE the
   * snapshot was read: a snapshot cannot speak for a lease that landed after it.
   */
  committedSerial: number | null;
};

/**
 * The process-local attempt registry for one scope: a map from attempt token
 * to registration, with a secondary index from subject id to the tokens
 * registered for it, so reconciling one subject costs its own attempts rather
 * than a walk over every live claim in the scope.
 */
export class AttemptRegistry extends Map<string, AttemptRegistration> {
  readonly #bySubject = new Map<string, Set<string>>();

  // Explicit rather than implicit: the coverage instrumentation counts a
  // derived class's synthesized constructor as a function it can never see run.
  constructor() {
    super();
  }

  override set(attemptToken: string, registration: AttemptRegistration): this {
    super.set(attemptToken, registration);
    let tokens = this.#bySubject.get(registration.subjectId);
    if (tokens === undefined) {
      tokens = new Set();
      this.#bySubject.set(registration.subjectId, tokens);
    }
    tokens.add(attemptToken);
    return this;
  }

  override delete(attemptToken: string): boolean {
    const registration = this.get(attemptToken);
    if (registration === undefined) return false;
    super.delete(attemptToken);
    const tokens = this.#bySubject.get(registration.subjectId);
    tokens?.delete(attemptToken);
    if (tokens?.size === 0) this.#bySubject.delete(registration.subjectId);
    return true;
  }

  override clear(): void {
    super.clear();
    this.#bySubject.clear();
  }

  /** The tokens currently registered for one subject, as a snapshot safe to release from. */
  tokensFor(subjectId: string): string[] {
    return [...(this.#bySubject.get(subjectId) ?? [])];
  }
}

let localLeaseCommits = 0;

/** Record one more lease committed by this process and return its serial. */
export function nextLeaseCommitSerial(): number {
  localLeaseCommits += 1;
  return localLeaseCommits;
}

/** The serial of the latest lease this process committed; read before a snapshot to fence reconciliation. */
export function leaseCommitSerial(): number {
  return localLeaseCommits;
}

/**
 * One scope's live attempts plus the number of handles currently holding it,
 * so the scope can be dropped once nothing references it.
 */
type ScopeRegistry = {
  readonly controllers: AttemptRegistry;
  handles: number;
};

const ATTEMPT_CONTROLLERS_BY_STORAGE = new WeakMap<Storage, Map<string, ScopeRegistry>>();

/**
 * The scope key carries the primitive's own tag as well as its identifiers, so
 * a mailbox and an outbox on one storage whose namespace and resource or owner
 * ids happen to coincide never share a registry.
 */
function scopeKey(primitive: string, namespace: string, scopeId: string): string {
  return `${primitive}:${encodeURIComponent(namespace)}:${encodeURIComponent(scopeId)}`;
}

/**
 * Acquire the shared attempt-controller registry for one scope in this process.
 * Every acquisition is balanced by {@link releaseAttemptControllerRegistry}
 * from the handle's `dispose()`.
 */
export function attemptControllerRegistry(
  storage: Storage,
  primitive: string,
  namespace: string,
  scopeId: string,
): AttemptRegistry {
  let byScope = ATTEMPT_CONTROLLERS_BY_STORAGE.get(storage);
  if (byScope === undefined) {
    byScope = new Map();
    ATTEMPT_CONTROLLERS_BY_STORAGE.set(storage, byScope);
  }
  const scope = scopeKey(primitive, namespace, scopeId);
  let entry = byScope.get(scope);
  if (entry === undefined) {
    entry = { controllers: new AttemptRegistry(), handles: 0 };
    byScope.set(scope, entry);
  }
  entry.handles += 1;
  return entry.controllers;
}

/**
 * Release one handle's hold on a scope registry.
 *
 * The scope is forgotten once no handle holds it and no attempt is live in it.
 * A service that creates short-lived handles for many resource ids over one
 * long-lived storage would otherwise retain a map per historical resource. A
 * live attempt owned by a sibling handle keeps the scope until it settles.
 */
export function releaseAttemptControllerRegistry(
  storage: Storage,
  primitive: string,
  namespace: string,
  scopeId: string,
): void {
  const byScope = ATTEMPT_CONTROLLERS_BY_STORAGE.get(storage);
  const scope = scopeKey(primitive, namespace, scopeId);
  const entry = byScope?.get(scope);
  if (byScope === undefined || entry === undefined) return;
  entry.handles = Math.max(0, entry.handles - 1);
  if (entry.handles === 0 && entry.controllers.size === 0) byScope.delete(scope);
}

/** Whether this process still tracks a registry for the scope. Diagnostics and tests. */
export function hasAttemptControllerScope(
  storage: Storage,
  primitive: string,
  namespace: string,
  scopeId: string,
): boolean {
  return (
    ATTEMPT_CONTROLLERS_BY_STORAGE.get(storage)?.has(scopeKey(primitive, namespace, scopeId)) ===
    true
  );
}
