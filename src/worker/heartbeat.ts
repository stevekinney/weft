// ---------------------------------------------------------------------------
// Visibility timeout keepalive via periodic heartbeats
// ---------------------------------------------------------------------------

const DEFAULT_INTERVAL_MS = 10_000;

/**
 * Sends periodic keepalive heartbeats from a remote worker to the server to
 * extend the task visibility timeout while activity execution is in progress.
 *
 * Construct with a `sendHeartbeat` callback (typically the worker's WebSocket
 * send function) and an optional interval in milliseconds (default: 10 000).
 * Call `start()` when a task is acquired and `stop()` when it completes.
 *
 * @example
 * ```ts
 * import { HeartbeatManager } from '@lostgradient/weft';
 *
 * let heartbeatFn = (details?: unknown) => {
 *   console.log('heartbeat', details);
 * };
 *
 * const manager = new HeartbeatManager(heartbeatFn, 5_000);
 * manager.start();
 * // ... execute long-running activity ...
 * manager.beat({ progress: 0.5 }); // one-off heartbeat with details
 * manager.stop();
 * ```
 */
export class HeartbeatManager {
  #interval: ReturnType<typeof setInterval> | null;
  #sendHeartbeat: (details?: unknown) => void;
  #intervalMs: number;

  constructor(sendHeartbeat: (details?: unknown) => void, intervalMs?: number) {
    this.#sendHeartbeat = sendHeartbeat;
    this.#intervalMs = intervalMs ?? DEFAULT_INTERVAL_MS;
    this.#interval = null;
  }

  /** Start sending periodic heartbeats. */
  start(): void {
    if (this.#interval !== null) {
      return;
    }

    this.#interval = setInterval(() => {
      this.#sendHeartbeat();
    }, this.#intervalMs);
  }

  /** Stop sending heartbeats. */
  stop(): void {
    if (this.#interval !== null) {
      clearInterval(this.#interval);
      this.#interval = null;
    }
  }

  /** Send a one-off heartbeat with optional details. */
  beat(details?: unknown): void {
    this.#sendHeartbeat(details);
  }

  get isRunning(): boolean {
    return this.#interval !== null;
  }
}
