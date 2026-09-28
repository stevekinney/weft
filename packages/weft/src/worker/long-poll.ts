import type { ActivityInterceptor } from '../core/interceptor.ts';
import { sleep } from '../runtime/portable.ts';
import { normalizeWorkerJsonValue, resolveActivityTable } from './activity-table.ts';
import {
  AttemptControllerTable,
  cancellationErrorMessage,
  DEFAULT_CANCELLED_TASK_ERROR,
} from './attempt-controllers.ts';
import {
  buildComposedInterceptor,
  executeWithInterceptors,
  type ComposedInterceptor,
} from './execute-with-interceptors.ts';
import {
  DEFAULT_RESULT_RETRY_BASE_DELAY_MS,
  DEFAULT_RESULT_RETRY_MAX_DELAY_MS,
  LongPollResultDelivery,
} from './long-poll-result-delivery.ts';
import type { WorkerManifest } from './manifest/index.ts';
import { buildWorkerManifest, type RemoteWorkerOptions } from './options.ts';
import type {
  RemoteWorkerActivityFunction,
  RemoteWorkerWorkflowDefinition,
} from './workflow-activity-binding.ts';

export interface LongPollWorkerOptions {
  serverUrl: string;
  workflows: Record<string, RemoteWorkerWorkflowDefinition>;
  deploymentName: string;
  buildId: string;
  concurrency?: number;
  queue?: string;
  artifactDigest?: string;
  manifest?: WorkerManifest;
  runtimeVersion?: string;
  startedAt?: number;
  capabilities?: RemoteWorkerOptions['capabilities'];
  pollTimeout?: number; // ms, default: 30000
  heartbeatIntervalMs?: number;
  headers?: Record<string, string>;
  interceptors?: ActivityInterceptor[];
  disconnectTimeoutMs?: number;
  resultRetryBaseDelayMs?: number;
  resultRetryMaxDelayMs?: number;
}

const WORKER_SESSION_CREDENTIAL_HEADER = 'Weft-Worker-Session-Token';

type SessionRegistrationResponse = { sessionId?: unknown; sessionToken?: unknown };

type PolledTask = {
  operationId: string;
  activityName: string;
  input: unknown;
  attempt?: number;
  headers?: Record<string, string>;
  workerId?: string;
  workflowExecutionToken?: string;
  workflowRevision?: string;
  attemptToken: string;
  visibilityTimeout?: number;
  lastHeartbeatDetails?: unknown;
};

const DEFAULT_CONCURRENCY = 10;
const DEFAULT_QUEUE = 'default';
const DEFAULT_POLL_TIMEOUT = 30_000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 10_000;
const DEFAULT_DISCONNECT_TIMEOUT_MS = 30_000;

function resolveLongPollWorkerOptions(options: LongPollWorkerOptions): {
  options: LongPollWorkerOptions;
  activities: Record<string, RemoteWorkerActivityFunction>;
} {
  return {
    options: {
      ...options,
      concurrency: options.concurrency ?? DEFAULT_CONCURRENCY,
      queue: options.queue ?? DEFAULT_QUEUE,
      pollTimeout: options.pollTimeout ?? DEFAULT_POLL_TIMEOUT,
      heartbeatIntervalMs: options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS,
      disconnectTimeoutMs: options.disconnectTimeoutMs ?? DEFAULT_DISCONNECT_TIMEOUT_MS,
    },
    activities: resolveActivityTable(options),
  };
}

export class LongPollWorker implements Disposable {
  #options: LongPollWorkerOptions;
  #activities: Record<string, RemoteWorkerActivityFunction>;
  #running: boolean;
  #ready: boolean;
  #sessionId: string | null;
  #sessionToken: string | null;
  #inFlight: number;
  #abortController: AbortController;
  #composedInterceptor: ComposedInterceptor | null;
  #taskAbortControllers: AttemptControllerTable;
  #delivery: LongPollResultDelivery | null;

  constructor(options: LongPollWorkerOptions) {
    const resolved = resolveLongPollWorkerOptions(options);
    this.#options = resolved.options;
    this.#activities = resolved.activities;
    this.#running = false;
    this.#ready = false;
    this.#sessionId = null;
    this.#sessionToken = null;
    this.#inFlight = 0;
    this.#abortController = new AbortController();
    this.#composedInterceptor = buildComposedInterceptor(options.interceptors);
    this.#taskAbortControllers = new AttemptControllerTable();
    this.#delivery = null;
  }

  start(): void {
    if (this.#running) {
      return;
    }

    this.#running = true;
    this.#ready = false;
    this.#abortController = new AbortController();
    void this.#pollLoop();
  }

  async stop(): Promise<{ unacknowledgedResults: number }> {
    this.#abortController.abort();
    this.#running = false;
    this.#ready = false;
    this.#abortAllTasks();

    const deadline =
      Date.now() + (this.#options.disconnectTimeoutMs ?? DEFAULT_DISCONNECT_TIMEOUT_MS);
    while (this.#inFlight > 0 && Date.now() < deadline) {
      await sleep(50);
    }
    if (this.#inFlight > 0) {
      console.warn(
        `[weft] LongPollWorker stop() timed out with ${String(this.#inFlight)} activities still in-flight — a non-cooperative activity may be ignoring its AbortSignal`,
      );
    }

    this.#delivery?.suspend();
    await this.#unregisterSession();
    const unacknowledgedResults = this.#delivery?.unacknowledgedCount ?? 0;
    if (unacknowledgedResults > 0) {
      console.warn(
        `[weft] LongPollWorker stopped with ${String(unacknowledgedResults)} result(s) still unacknowledged; they will resend on the next start()`,
      );
    }
    return { unacknowledgedResults };
  }

  get inFlight(): number {
    return this.#inFlight;
  }

  get running(): boolean {
    return this.#running;
  }

  get ready(): boolean {
    return this.#ready;
  }

  get unacknowledgedResultCount(): number {
    return this.#delivery?.unacknowledgedCount ?? 0;
  }

  [Symbol.dispose](): void {
    this.#running = false;
    this.#ready = false;
    this.#abortController.abort();
    this.#abortAllTasks();
    this.#delivery?.dispose();
    void this.#unregisterSession();
  }

  #abortAllTasks(): void {
    this.#taskAbortControllers.abortAll();
  }

  #buildRegisterUrl(): string {
    return `${this.#options.serverUrl}/api/v1/worker-sessions`;
  }

  #buildPollUrl(): string {
    const params = new URLSearchParams();
    params.set('timeout', String(this.#options.pollTimeout ?? DEFAULT_POLL_TIMEOUT));
    return `${this.#options.serverUrl}/api/v1/worker-sessions/${encodeURIComponent(this.#requireSessionId())}/tasks?${params.toString()}`;
  }

  #buildResultUrl(): string {
    return `${this.#options.serverUrl}/api/v1/worker-sessions/${encodeURIComponent(this.#requireSessionId())}/results`;
  }

  #buildHeartbeatUrl(): string {
    return `${this.#options.serverUrl}/api/v1/worker-sessions/${encodeURIComponent(this.#requireSessionId())}/heartbeat`;
  }

  #requireSessionId(): string {
    if (this.#sessionId === null) throw new Error('LongPollWorker is not registered.');
    return this.#sessionId;
  }

  #sessionHeaders(): Record<string, string> | undefined {
    if (this.#sessionToken === null) return this.#options.headers;
    return { ...this.#options.headers, [WORKER_SESSION_CREDENTIAL_HEADER]: this.#sessionToken };
  }

  #sessionRegistrationBody(): Record<string, unknown> {
    return {
      manifest: buildWorkerManifest({
        serverUrl: this.#options.serverUrl,
        workflows: this.#options.workflows,
        deploymentName: this.#options.deploymentName,
        buildId: this.#options.buildId,
        ...(this.#options.artifactDigest !== undefined
          ? { artifactDigest: this.#options.artifactDigest }
          : {}),
        ...(this.#options.manifest !== undefined ? { manifest: this.#options.manifest } : {}),
        ...(this.#options.runtimeVersion !== undefined
          ? { runtimeVersion: this.#options.runtimeVersion }
          : {}),
        ...(this.#options.startedAt !== undefined ? { startedAt: this.#options.startedAt } : {}),
        ...(this.#options.capabilities !== undefined
          ? { capabilities: this.#options.capabilities }
          : {}),
      }),
      concurrency: this.#options.concurrency ?? DEFAULT_CONCURRENCY,
      queue: this.#options.queue ?? DEFAULT_QUEUE,
      ...(this.#options.startedAt !== undefined ? { startedAt: this.#options.startedAt } : {}),
    };
  }

  #configureDelivery(resultUrl: string): LongPollResultDelivery {
    const headers = this.#sessionHeaders();
    if (this.#delivery !== null) {
      this.#delivery.updateResultUrl(resultUrl);
      this.#delivery.updateHeaders(headers);
      return this.#delivery;
    }
    this.#delivery = new LongPollResultDelivery({
      resultUrl,
      ...(headers === undefined ? {} : { headers }),
      retryBaseDelayMs: this.#options.resultRetryBaseDelayMs ?? DEFAULT_RESULT_RETRY_BASE_DELAY_MS,
      retryMaxDelayMs: this.#options.resultRetryMaxDelayMs ?? DEFAULT_RESULT_RETRY_MAX_DELAY_MS,
    });
    return this.#delivery;
  }

  async #registerSession(): Promise<boolean> {
    try {
      const response = await fetch(this.#buildRegisterUrl(), {
        method: 'POST',
        headers: { ...this.#options.headers, 'Content-Type': 'application/json' },
        body: JSON.stringify(this.#sessionRegistrationBody()),
        signal: this.#abortController.signal,
      });
      if (!response.ok) {
        this.#ready = false;
        return false;
      }
      const body = (await response.json().catch(() => ({}))) as SessionRegistrationResponse;
      if (
        typeof body.sessionId !== 'string' ||
        body.sessionId.length === 0 ||
        typeof body.sessionToken !== 'string' ||
        body.sessionToken.length === 0
      ) {
        this.#ready = false;
        return false;
      }
      this.#sessionId = body.sessionId;
      this.#sessionToken = body.sessionToken;
      const delivery = this.#configureDelivery(this.#buildResultUrl());
      this.#ready = true;
      delivery.flush();
      return true;
    } catch {
      return false;
    }
  }

  async #unregisterSession(): Promise<void> {
    const sessionId = this.#sessionId;
    if (sessionId === null) return;
    this.#sessionId = null;
    const headers = this.#sessionHeaders();
    this.#sessionToken = null;
    try {
      await fetch(
        `${this.#options.serverUrl}/api/v1/worker-sessions/${encodeURIComponent(sessionId)}`,
        {
          method: 'DELETE',
          ...(headers === undefined ? {} : { headers }),
        },
      );
    } catch {}
  }

  #atCapacity(): boolean {
    if (this.#delivery?.full === true) {
      if (this.#delivery.shouldWarnFull()) {
        console.warn(
          `[weft] LongPollWorker result buffer full (${String(this.#delivery.unacknowledgedCount)}); declining new tasks until the backlog drains`,
        );
      }
      return true;
    }
    return this.#inFlight >= (this.#options.concurrency ?? DEFAULT_CONCURRENCY);
  }

  async #pollOnce(pollUrl: string): Promise<void> {
    const headers = this.#sessionHeaders();
    const response = await fetch(pollUrl, {
      ...(headers === undefined ? {} : { headers }),
      signal: this.#abortController.signal,
    });
    if (response.status === 204) return;
    if (!response.ok) {
      await sleep(1000);
      return;
    }
    void this.#executeTask((await response.json()) as PolledTask);
  }

  async #pollLoop(): Promise<void> {
    while (this.#running && !this.#abortController.signal.aborted) {
      if (!this.#ready && !(await this.#registerSession())) {
        await sleep(1000);
        continue;
      }
      const pollUrl = this.#buildPollUrl();
      if (this.#atCapacity()) {
        await sleep(100);
        continue;
      }

      try {
        await this.#pollOnce(pollUrl);
      } catch {
        if (this.#running) await sleep(1000);
      }
    }
  }

  async #sendHeartbeat(task: PolledTask, details?: unknown): Promise<void> {
    const controller = this.#taskAbortControllers.get(task.operationId, task.attemptToken);
    if (controller === undefined || controller.signal.aborted) return;
    const normalizedDetails = details === undefined ? undefined : normalizeWorkerJsonValue(details);
    try {
      const response = await fetch(this.#buildHeartbeatUrl(), {
        method: 'POST',
        headers: { ...this.#sessionHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          operationId: task.operationId,
          workerId: task.workerId,
          attemptToken: task.attemptToken,
          ...(normalizedDetails !== undefined ? { details: normalizedDetails } : {}),
        }),
        signal: this.#abortController.signal,
      });
      if (!response.ok) return;
      const body = (await response.json()) as {
        ok?: boolean;
        cancelled?: boolean;
        reason?: string;
      };
      if (body.cancelled === true) {
        controller.abort(body.reason ?? DEFAULT_CANCELLED_TASK_ERROR);
      }
    } catch {}
  }

  async #executeTask(task: PolledTask): Promise<void> {
    this.#inFlight += 1;

    const taskAbortController = new AbortController();
    this.#taskAbortControllers.set(task.operationId, task.attemptToken, taskAbortController);
    const heartbeatTimer = setInterval(
      () => void this.#sendHeartbeat(task),
      this.#options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS,
    );
    this.#taskAbortControllers.setHeartbeatTimer(
      task.operationId,
      task.attemptToken,
      heartbeatTimer,
    );

    try {
      await this.#executeKnownTask(task, taskAbortController);
    } catch (error) {
      await this.#deliverTaskError(task, taskAbortController, error);
    } finally {
      clearInterval(heartbeatTimer);
      this.#taskAbortControllers.delete(task.operationId, task.attemptToken);
      this.#inFlight -= 1;
    }
  }

  async #executeKnownTask(task: PolledTask, taskAbortController: AbortController): Promise<void> {
    const delivery = this.#requireDelivery();
    const activityFunction = this.#activities[task.activityName];
    if (activityFunction === undefined) {
      await delivery.deliver({
        operationId: task.operationId,
        ...(task.workerId === undefined ? {} : { workerId: task.workerId }),
        attemptToken: task.attemptToken,
        status: 'failed',
        error: `Unknown activity: ${task.activityName}`,
      });
      return;
    }
    const result = await executeWithInterceptors(
      activityFunction,
      task,
      this.#composedInterceptor,
      taskAbortController.signal,
      (details) => void this.#sendHeartbeat(task, details),
    );
    await delivery.deliver({
      operationId: task.operationId,
      ...(task.workerId === undefined ? {} : { workerId: task.workerId }),
      attemptToken: task.attemptToken,
      status: 'completed',
      value: normalizeWorkerJsonValue(result),
    });
  }

  async #deliverTaskError(
    task: PolledTask,
    taskAbortController: AbortController,
    error: unknown,
  ): Promise<void> {
    await this.#requireDelivery().deliver({
      operationId: task.operationId,
      ...(task.workerId === undefined ? {} : { workerId: task.workerId }),
      attemptToken: task.attemptToken,
      ...(taskAbortController.signal.aborted
        ? {
            status: 'cancelled',
            cancelled: true,
            error: cancellationErrorMessage(taskAbortController.signal),
          }
        : { status: 'failed', error: error instanceof Error ? error.message : String(error) }),
    });
  }

  #requireDelivery(): LongPollResultDelivery {
    if (this.#delivery === null)
      throw new Error('LongPollWorker result delivery is not registered.');
    return this.#delivery;
  }
}
