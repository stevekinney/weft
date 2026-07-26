export interface WorkerTurnState {
  worker: Worker;
  workflowId: string;
  turnId: number;
  kind: 'run' | 'resume';
  timeoutMs: number | undefined;
}

export type WorkerTurnTimeoutResolverForTesting = (
  turn: Pick<WorkerTurnState, 'workflowId' | 'kind'>,
) => number;

interface TrackedWorkerTurn extends WorkerTurnState {
  timeout: ReturnType<typeof setTimeout> | null;
}

export class WorkerTurnWatchdog {
  readonly #turnsByWorker = new Map<Worker, TrackedWorkerTurn>();
  readonly #timeoutMs: number | undefined;
  readonly #onTimeout: (turn: WorkerTurnState) => void;
  #timeoutResolverForTesting: WorkerTurnTimeoutResolverForTesting | null = null;

  constructor(timeoutMs: number | undefined, onTimeout: (turn: WorkerTurnState) => void) {
    this.#timeoutMs = timeoutMs;
    this.#onTimeout = onTimeout;
  }

  begin(
    worker: Worker,
    workflowId: string,
    turnId: number,
    kind: WorkerTurnState['kind'],
    timeoutMs = this.#timeoutMs,
  ): void {
    this.clear(worker);
    const resolvedTimeoutMs = this.#timeoutResolverForTesting?.({ workflowId, kind }) ?? timeoutMs;
    const turn: TrackedWorkerTurn = {
      worker,
      workflowId,
      turnId,
      kind,
      timeoutMs: resolvedTimeoutMs,
      timeout: null,
    };

    if (resolvedTimeoutMs !== undefined) {
      turn.timeout = setTimeout(() => {
        if (this.#turnsByWorker.get(worker) === turn) {
          this.#onTimeout(turn);
        }
      }, resolvedTimeoutMs);
    }

    this.#turnsByWorker.set(worker, turn);
  }

  setTimeoutResolverForTesting(resolver: WorkerTurnTimeoutResolverForTesting): void {
    this.#timeoutResolverForTesting = resolver;
  }

  clear(worker: Worker): void {
    const turn = this.#turnsByWorker.get(worker);
    if (!turn) return;
    if (turn.timeout !== null) {
      clearTimeout(turn.timeout);
    }
    this.#turnsByWorker.delete(worker);
  }

  clearAll(): void {
    for (const worker of this.#turnsByWorker.keys()) {
      this.clear(worker);
    }
  }

  get(worker: Worker): WorkerTurnState | undefined {
    return this.#turnsByWorker.get(worker);
  }
}
