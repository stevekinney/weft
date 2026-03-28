// ---------------------------------------------------------------------------
// Server-side worker tracking and least-loaded routing
// ---------------------------------------------------------------------------

export interface WorkerInfo {
  id: string;
  queue: string;
  activities: string[];
  concurrency: number;
  inFlight: number;
  connectedAt: number;
  lastHeartbeat: number;
}

export interface RoutingOptions {
  sticky?: string; // preferred worker ID for cache locality
  queue?: string;
}

export interface InFlightTask {
  operationId: string;
  workerId: string;
  deadline: number; // absolute timestamp
}

export class WorkerRegistry {
  #workers: Map<string, WorkerInfo>;
  #inFlightTasks: Map<string, InFlightTask>;

  constructor() {
    this.#workers = new Map();
    this.#inFlightTasks = new Map();
  }

  /** Register a worker. */
  register(info: Omit<WorkerInfo, 'connectedAt' | 'lastHeartbeat' | 'inFlight'>): void {
    const now = Date.now();

    this.#workers.set(info.id, {
      ...info,
      inFlight: 0,
      connectedAt: now,
      lastHeartbeat: now,
    });
  }

  /** Unregister a worker. Returns its info for reassignment of in-flight tasks. */
  unregister(workerId: string): WorkerInfo | undefined {
    const info = this.#workers.get(workerId);
    if (info !== undefined) {
      this.#workers.delete(workerId);
    }
    return info;
  }

  /** Record a heartbeat from a worker. */
  heartbeat(workerId: string): void {
    const info = this.#workers.get(workerId);
    if (info !== undefined) {
      info.lastHeartbeat = Date.now();
    }
  }

  /** Increment in-flight count for a worker. */
  taskAssigned(workerId: string): void {
    const info = this.#workers.get(workerId);
    if (info !== undefined) {
      info.inFlight += 1;
    }
  }

  /** Decrement in-flight count. */
  taskCompleted(workerId: string): void {
    const info = this.#workers.get(workerId);
    if (info !== undefined) {
      info.inFlight = Math.max(0, info.inFlight - 1);
    }
  }

  /**
   * Find the best worker for a task using least-loaded routing.
   *
   * Default strategy: pick the worker with the lowest `inFlight` count
   * among those that support the requested activity and have spare capacity
   * (`inFlight < concurrency`). When a sticky preference is provided and
   * that worker qualifies, it wins regardless of load.
   */
  findWorker(activityName: string, options?: RoutingOptions): WorkerInfo | undefined {
    const queue = options?.queue;
    const stickyId = options?.sticky;

    let best: WorkerInfo | undefined;
    let stickyCandidate: WorkerInfo | undefined;

    for (const worker of this.#workers.values()) {
      if (queue !== undefined && worker.queue !== queue) continue;
      if (!worker.activities.includes(activityName)) continue;
      if (worker.inFlight >= worker.concurrency) continue;

      // Track sticky candidate separately so we can prefer it when available.
      if (stickyId !== undefined && worker.id === stickyId) {
        stickyCandidate = worker;
      }

      // Least-loaded: keep the worker with the lowest inFlight count.
      if (best === undefined || worker.inFlight < best.inFlight) {
        best = worker;
      }
    }

    return stickyCandidate ?? best;
  }

  /** Track a task assignment with a visibility timeout deadline. */
  assignTask(workerId: string, operationId: string, visibilityTimeout: number): void {
    const deadline = Date.now() + visibilityTimeout;

    this.#inFlightTasks.set(operationId, {
      operationId,
      workerId,
      deadline,
    });

    this.taskAssigned(workerId);
  }

  /** Return tasks whose deadline has passed for reassignment. */
  checkExpiredTasks(now: number): InFlightTask[] {
    const expired: InFlightTask[] = [];

    for (const task of this.#inFlightTasks.values()) {
      if (task.deadline <= now) {
        expired.push(task);
      }
    }

    return expired;
  }

  /** Extend the visibility timeout deadline for an in-flight task (heartbeat). */
  extendVisibility(operationId: string, extension: number): void {
    const task = this.#inFlightTasks.get(operationId);
    if (task !== undefined) {
      task.deadline = Date.now() + extension;
    }
  }

  /** Check whether an operation is currently assigned to a worker. */
  isAssigned(operationId: string): boolean {
    return this.#inFlightTasks.has(operationId);
  }

  /** Complete an in-flight task: remove tracking and decrement the worker's counter. */
  completeTask(operationId: string): InFlightTask | undefined {
    const task = this.#inFlightTasks.get(operationId);
    if (task === undefined) return undefined;

    this.#inFlightTasks.delete(operationId);
    this.taskCompleted(task.workerId);
    return task;
  }

  /** Look up a worker by ID. */
  getWorker(workerId: string): WorkerInfo | undefined {
    return this.#workers.get(workerId);
  }

  /** Get all registered workers. */
  getAll(): WorkerInfo[] {
    return [...this.#workers.values()];
  }

  /** Get worker count. */
  get size(): number {
    return this.#workers.size;
  }
}
