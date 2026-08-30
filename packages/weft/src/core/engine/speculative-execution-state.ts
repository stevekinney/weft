export class SpeculativeExecutionState {
  readonly #verifications: Array<Promise<{ failed: false } | { failed: true; error: unknown }>>;
  readonly #compensations: Array<() => Promise<void>>;

  constructor() {
    this.#verifications = [];
    this.#compensations = [];
  }

  recordVerification(verification: Promise<void>): void {
    this.#verifications.push(
      verification.then(
        () => ({ failed: false as const }),
        (error) => ({ failed: true as const, error }),
      ),
    );
  }

  recordCompensation(compensation: () => Promise<void>): void {
    this.#compensations.push(compensation);
  }

  async drainVerifications(): Promise<void> {
    const outcomes = await Promise.all(this.#verifications);
    const failure = outcomes.find((outcome) => outcome.failed);
    if (failure) {
      throw failure.error;
    }
  }

  async rollback(): Promise<void> {
    for (let index = this.#compensations.length - 1; index >= 0; index--) {
      try {
        await this.#compensations[index]!();
      } catch {
        // Best-effort rollback continues through failed compensations.
      }
    }
    await Promise.all(this.#verifications);
  }
}
