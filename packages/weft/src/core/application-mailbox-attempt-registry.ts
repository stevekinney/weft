/**
 * The process-local registry of live claim attempts for one mailbox scope
 * (WFT-84), and the lease-commit serial that fences reconciliation against it.
 *
 * Registrations live here rather than in durable storage because an
 * `AbortSignal` is process-local by construction; the registry is what lets a
 * cancellation, settlement, or maintenance pass in this process reach a
 * claimant in this process. Another process learns from `renew()` instead.
 *
 * @module core/application-mailbox-attempt-registry
 */

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
  /** The command the attempt belongs to, so a caller-supplied token cannot release another command's attempt. */
  readonly commandId: string;
  /**
   * The process-local lease-commit serial this attempt's lease landed under, or
   * `null` while its compare-and-swap is still in flight. A reconciliation from
   * a durable snapshot releases only attempts that committed BEFORE the
   * snapshot was read: a snapshot cannot speak for a lease that landed after it.
   */
  committedSerial: number | null;
};

/**
 * The process-local attempt registry for one mailbox scope: a map from attempt
 * token to registration, with a secondary index from command id to the tokens
 * registered for it, so reconciling one command costs its own attempts rather
 * than a walk over every live claim in the scope.
 */
export class AttemptRegistry extends Map<string, AttemptRegistration> {
  readonly #byCommand = new Map<string, Set<string>>();

  // Explicit rather than implicit: the coverage instrumentation counts a
  // derived class's synthesized constructor as a function it can never see run.
  constructor() {
    super();
  }

  override set(attemptToken: string, registration: AttemptRegistration): this {
    super.set(attemptToken, registration);
    let tokens = this.#byCommand.get(registration.commandId);
    if (tokens === undefined) {
      tokens = new Set();
      this.#byCommand.set(registration.commandId, tokens);
    }
    tokens.add(attemptToken);
    return this;
  }

  override delete(attemptToken: string): boolean {
    const registration = this.get(attemptToken);
    if (registration === undefined) return false;
    super.delete(attemptToken);
    const tokens = this.#byCommand.get(registration.commandId);
    tokens?.delete(attemptToken);
    if (tokens?.size === 0) this.#byCommand.delete(registration.commandId);
    return true;
  }

  override clear(): void {
    super.clear();
    this.#byCommand.clear();
  }

  /** The tokens currently registered for one command, as a snapshot safe to release from. */
  tokensFor(commandId: string): string[] {
    return [...(this.#byCommand.get(commandId) ?? [])];
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
