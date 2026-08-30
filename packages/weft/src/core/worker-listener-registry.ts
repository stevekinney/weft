interface WorkerListeners {
  message: (event: MessageEvent<unknown>) => void;
  error: (event: ErrorEvent) => void;
  messageerror: (event: MessageEvent) => void;
}

export class WorkerListenerRegistry {
  readonly #workerListeners = new Map<Worker, WorkerListeners>();

  attach(
    worker: Worker,
    handlers: {
      message: (message: unknown) => void;
      error: (errorEvent: ErrorEvent) => void;
      messageerror: () => void;
    },
  ): void {
    if (this.#workerListeners.has(worker)) {
      return;
    }

    const listeners: WorkerListeners = {
      message: (event: MessageEvent<unknown>) => {
        handlers.message(event.data);
      },
      error: handlers.error,
      messageerror: handlers.messageerror,
    };

    this.#workerListeners.set(worker, listeners);
    worker.addEventListener('message', listeners.message as EventListener);
    worker.addEventListener('error', listeners.error as EventListener);
    worker.addEventListener('messageerror', listeners.messageerror as EventListener);
  }

  detach(worker: Worker): void {
    const listeners = this.#workerListeners.get(worker);
    if (!listeners) return;
    worker.removeEventListener('message', listeners.message as EventListener);
    worker.removeEventListener('error', listeners.error as EventListener);
    worker.removeEventListener('messageerror', listeners.messageerror as EventListener);
    this.#workerListeners.delete(worker);
  }

  detachIfIdle(worker: Worker, workerIsIdle: (worker: Worker) => boolean): void {
    if (workerIsIdle(worker)) {
      this.detach(worker);
    }
  }

  detachAll(): void {
    for (const worker of this.#workerListeners.keys()) {
      this.detach(worker);
    }
  }
}
