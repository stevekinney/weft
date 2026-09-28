/**
 * Idempotent, memoized disposal for a class exposing both `Symbol.dispose`
 * and `Symbol.asyncDispose` (COR-113: "termination is idempotent — repeated
 * disposal or close signals share one memoized promise; timers are cleared
 * and realms terminated exactly once").
 *
 * `teardown` (shared strategy-internal cleanup — watchdogs, listeners,
 * ownership) runs at most once regardless of which entry point, or how many
 * times, is called. `disposeSync`/`disposeAsync` are the owned pool's own
 * matching disposal, run immediately after. Extracted from
 * `WorkerExecutionStrategy` to keep that file under the repository's
 * file-size ceiling, mirroring `WorkerFaultHandler`'s own extraction; every
 * method here previously lived as a private method on that class.
 *
 * @module core/worker-execution-disposal
 */
export interface WorkerExecutionDisposalOptions {
  readonly teardown: () => void;
  readonly disposeSync: () => void;
  readonly disposeAsync: () => Promise<void>;
}

export class WorkerExecutionDisposal {
  readonly #options: WorkerExecutionDisposalOptions;
  #disposed = false;
  #asyncDisposePromise: Promise<void> | null = null;

  constructor(options: WorkerExecutionDisposalOptions) {
    this.#options = options;
  }

  get isDisposed(): boolean {
    return this.#disposed;
  }

  /** Synchronous disposal. A no-op once already disposed, by either entry point, so the pool is never disposed twice. */
  disposeSync(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#options.teardown();
    this.#options.disposeSync();
  }

  /** Asynchronous disposal. Repeated or concurrent calls share one memoized promise instead of each re-disposing the pool. */
  disposeAsync(): Promise<void> {
    this.#asyncDisposePromise ??= this.#performAsyncDispose();
    return this.#asyncDisposePromise;
  }

  async #performAsyncDispose(): Promise<void> {
    // A prior sync disposeSync() may have already torn down and disposed the pool.
    if (this.#disposed) return;
    this.#disposed = true;
    this.#options.teardown();
    await this.#options.disposeAsync();
  }
}
