/**
 * One task on an A2A peer: sends the first message, follows the task by streaming (with
 * `SubscribeToTask` reconnects) or by polling `GetTask`, and cancels it.
 *
 * @module a2a/peer-task
 */

import { type Message, type SendMessageRequest, type Task } from '@a2a-js/sdk';
import type { Client, RequestOptions } from '@a2a-js/sdk/client';

import type {
  A2APeerOutcome,
  A2APeerProvenance,
  A2APeerTask,
  A2APeerTaskState,
} from './peer-client-types.ts';
import { A2APeerError } from './peer-client-types.ts';
import { backoffMs, retryRequest, type PeerRetryPolicy } from './peer-retry.ts';
import { isTerminalState, PeerTaskTracker, type PeerStreamEvent } from './peer-task-tracker.ts';

/** The bounds and collaborators one peer task runs with. */
export interface PeerTaskContext extends PeerRetryPolicy {
  /** The SDK client for the selected interface. */
  readonly client: Client;
  /** Whether to stream (the card advertised it) or poll. */
  readonly streaming: boolean;
  /** The peer's identity, without a task id. */
  readonly peer: Omit<A2APeerProvenance, 'taskId'>;
  /** Request options (extension headers) for every call; `signal` is added per call. */
  readonly requestOptions: RequestOptions;
  /** Media types the client accepts back. */
  readonly acceptedOutputModes: readonly string[];
  /** Delay before the first `GetTask` poll; doubles to `maxDelayMs`. */
  readonly pollIntervalMs: number;
  /** How long `result()` may wait for the task to stop. */
  readonly taskTimeoutMs: number;
  /** The most artifact content kept per artifact. */
  readonly artifactLimit: number;
  /** Told of a failure that ends the wait for the task, so the client can drop a stale card. */
  readonly onFailure?: ((error: A2APeerError) => void) | undefined;
}

type EventStream = AsyncGenerator<PeerStreamEvent, void, undefined>;

function isTask(value: Message | Task): value is Task {
  return 'status' in value;
}

/** One task on a peer, from its first request to the outcome the caller waits for. */
export class PeerTaskRun implements A2APeerTask {
  private readonly follow = new AbortController();
  private stream: EventStream | undefined;
  private reconnects = 0;
  private pollDelay: number;
  private timedOut = false;
  private settled: Promise<A2APeerOutcome> | undefined;
  private cancelling: Promise<A2APeerOutcome> | undefined;
  private readonly context: PeerTaskContext;
  private readonly tracker: PeerTaskTracker;
  private detach: (() => void) | undefined;
  private opened = false;

  constructor(context: PeerTaskContext, tracker: PeerTaskTracker) {
    this.context = context;
    this.tracker = tracker;
    this.pollDelay = Math.min(context.pollIntervalMs, context.maxDelayMs);
  }

  get taskId(): string {
    return this.tracker.taskId();
  }

  get contextId(): string {
    return this.tracker.contextId();
  }

  get provenance(): A2APeerProvenance {
    return this.tracker.provenance();
  }

  state(): A2APeerTaskState {
    return this.tracker.state();
  }

  /** The first request: a streaming peer opens its stream here, a polling peer answers at once. */
  async open(request: SendMessageRequest): Promise<void> {
    if (this.context.streaming) {
      const first = await this.withRetry(async () => {
        const opened = this.context.client.sendMessageStream(request, this.callOptions());
        const head = await this.boundedRead(opened);
        if (head.done === true) {
          throw new A2APeerError('protocol', 'The peer closed the stream without a response.');
        }
        return { opened, head: head.value };
      }, this.follow.signal);
      this.stream = first.opened;
      this.tracker.apply(first.head);
    } else {
      const response = await this.withRetry(() => this.boundedSend(request), this.follow.signal);
      if (isTask(response)) this.tracker.applyTask(response);
      else this.tracker.apply({ payload: { $case: 'message', value: response } });
    }
    // A first response that names no task leaves nothing to follow or cancel.
    if (this.tracker.taskId() === '' && !this.tracker.stopped()) {
      this.closeStream();
      throw new A2APeerError('protocol', "The peer's first response did not name a task.");
    }
    this.tracker.markHeadSeen();
    this.opened = true;
  }

  /**
   * Reads the task the peer already holds instead of sending: the task's current state is the
   * first response, so one that has already stopped counts as stopped.
   */
  async attach(taskId: string): Promise<void> {
    const task = await this.withRetry(() => this.boundedGetTask(taskId), this.follow.signal);
    this.tracker.applyTask(task);
    this.tracker.markHeadSeen();
    this.opened = true;
  }

  /**
   * The first stream event, bounded by the task timeout: the request timeout ends once headers
   * arrive, so a peer that never emits an event would otherwise hold `send()` open forever.
   */
  private async boundedRead(opened: EventStream): Promise<IteratorResult<PeerStreamEvent, void>> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(
          new A2APeerError(
            'timeout',
            `The peer sent no first event within ${this.context.taskTimeoutMs} ms.`,
          ),
        );
      }, this.context.taskTimeoutMs);
    });
    try {
      return await Promise.race([opened.next(), expired]);
    } catch (error) {
      void Promise.allSettled([opened.return()]);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * The opening non-streaming request, bounded by the task timeout: the request timeout ends once
   * headers arrive, so a peer that stalls mid-body would otherwise hold `send()` open forever.
   */
  private boundedSend(request: SendMessageRequest): Promise<Message | Task> {
    return this.bounded((options) => this.context.client.sendMessage(request, options));
  }

  /** The opening `GetTask` of an attach, bounded the same way as {@link boundedSend}. */
  private boundedGetTask(taskId: string): Promise<Task> {
    return this.bounded((options) => this.getTask(options, taskId));
  }

  private async bounded<T>(call: (options: RequestOptions) => Promise<T>): Promise<T> {
    const bound = new AbortController();
    let expired = false;
    const timer = setTimeout(() => {
      expired = true;
      bound.abort();
    }, this.context.taskTimeoutMs);
    try {
      // Either signal ends the request, one that has already aborted included.
      return await call({
        ...this.context.requestOptions,
        signal: AbortSignal.any([this.follow.signal, bound.signal]),
      });
    } catch (error) {
      if (!expired) throw error;
      throw new A2APeerError(
        'timeout',
        `The peer sent no complete response within ${this.context.taskTimeoutMs} ms.`,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  /** Whether the first response has arrived, so the task has an identity to cancel. */
  hasOpened(): boolean {
    return this.opened;
  }

  /** Aborts the first request while it is still in flight. */
  abortOpen(): void {
    this.follow.abort();
  }

  /** Registers what to undo when the task stops being followed. */
  onSettled(detach: () => void): void {
    this.detach = detach;
  }

  result(): Promise<A2APeerOutcome> {
    this.settled ??= this.settle();
    return this.settled;
  }

  cancel(reason?: string): Promise<A2APeerOutcome> {
    this.cancelling ??= this.doCancel(reason);
    return this.cancelling;
  }

  private callOptions(): RequestOptions {
    return { ...this.context.requestOptions, signal: this.follow.signal };
  }

  private withRetry<T>(call: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    return retryRequest(this.context, call, signal);
  }

  private closeStream(): void {
    const open = this.stream;
    this.stream = undefined;
    if (open !== undefined) void Promise.allSettled([open.return()]);
  }

  private async settle(): Promise<A2APeerOutcome> {
    const timer = setTimeout(() => {
      this.timedOut = true;
      this.follow.abort();
    }, this.context.taskTimeoutMs);
    try {
      await this.followTask();
      if (this.timedOut) return await this.failOnTimeout();
      return this.cancelling === undefined ? this.tracker.outcome() : await this.cancelling;
    } finally {
      clearTimeout(timer);
      this.closeStream();
      this.detach?.();
    }
  }

  private async failOnTimeout(): Promise<never> {
    if (!this.tracker.stopped()) await this.cancel('task timeout');
    throw new A2APeerError(
      'timeout',
      `The peer task did not stop within ${this.context.taskTimeoutMs} ms; it was canceled.`,
    );
  }

  private async followTask(): Promise<void> {
    const aborted = new Promise<'aborted'>((resolve) => {
      if (this.follow.signal.aborted) resolve('aborted');
      else this.follow.signal.addEventListener('abort', () => resolve('aborted'), { once: true });
    });
    while (!this.tracker.stopped() && !this.follow.signal.aborted) {
      try {
        await this.step(aborted);
      } catch (error) {
        this.recoverFromStepError(error);
      }
    }
  }

  private async step(aborted: Promise<'aborted'>): Promise<void> {
    if (this.stream !== undefined) return this.readStream(aborted);
    if (this.canResubscribe()) return this.resubscribe();
    return this.poll();
  }

  private canResubscribe(): boolean {
    return this.context.streaming && this.reconnects < this.context.attempts && this.taskId !== '';
  }

  private async readStream(aborted: Promise<'aborted'>): Promise<void> {
    const next = await Promise.race([this.stream?.next(), aborted]);
    if (next === 'aborted') return this.closeStream();
    if (next === undefined || next.done === true) {
      this.stream = undefined;
      return;
    }
    // A resubscribed stream opens with a snapshot of the task; only a later event is progress,
    // so a stream that opens and closes with nothing new keeps spending attempts.
    if (next.value.payload?.$case !== 'task') this.reconnects = 0;
    this.tracker.apply(next.value);
  }

  private async resubscribe(): Promise<void> {
    this.reconnects += 1;
    if (this.reconnects > 1) {
      await this.context.sleep(backoffMs(this.context, this.reconnects - 1), this.follow.signal);
    }
    if (this.follow.signal.aborted) return;
    this.stream = this.context.client.resubscribeTask(
      { tenant: '', id: this.taskId },
      this.callOptions(),
    );
  }

  private async poll(): Promise<void> {
    await this.context.sleep(this.pollDelay, this.follow.signal);
    this.pollDelay = Math.min(this.pollDelay * 2, this.context.maxDelayMs);
    if (this.follow.signal.aborted) return;
    const task = await this.withRetry(() => this.getTask(this.callOptions()), this.follow.signal);
    this.tracker.applyTask(task);
  }

  private getTask(options: RequestOptions, taskId: string = this.taskId): Promise<Task> {
    return this.context.client.getTask(
      { tenant: '', id: taskId, historyLength: undefined },
      options,
    );
  }

  /** A broken stream is replaced; anything else ends the wait. */
  private recoverFromStepError(error: unknown): void {
    if (this.follow.signal.aborted) return;
    const classified = this.context.classify(error);
    const recoverable = classified.retryable || classified.code === 'protocol';
    if (this.stream === undefined || !recoverable) {
      this.context.onFailure?.(classified);
      throw classified;
    }
    this.closeStream();
  }

  private async doCancel(reason?: string): Promise<A2APeerOutcome> {
    if (this.tracker.isCanceledLocally() || this.tracker.isTerminal()) {
      return this.tracker.outcome();
    }
    this.follow.abort();
    this.closeStream();
    if (this.taskId === '') {
      this.tracker.cancelLocally({ confirmed: false, error: 'the peer has not named the task' });
      return this.tracker.outcome();
    }
    try {
      await this.sendCancel(reason);
    } catch (error) {
      await this.recoverFromCancelError(this.context.classify(error));
    }
    return this.tracker.outcome();
  }

  private async sendCancel(reason: string | undefined): Promise<void> {
    const task = await this.withRetry(() =>
      this.context.client.cancelTask(
        {
          tenant: '',
          id: this.taskId,
          metadata: reason === undefined ? undefined : { reason },
        },
        this.context.requestOptions,
      ),
    );
    this.tracker.applyTask(task);
    if (this.tracker.state() === 'canceled') this.tracker.cancelLocally({ confirmed: true });
    else if (!this.tracker.isTerminal()) {
      this.tracker.cancelLocally({
        confirmed: false,
        error: `the peer left the task ${this.tracker.state()}`,
      });
    }
  }

  private async recoverFromCancelError(error: A2APeerError): Promise<void> {
    this.tracker.cancelLocally({ confirmed: false, error: error.message });
    if (error.code !== 'task-not-cancelable') return;
    // The task may have finished first; report the state it is really in.
    try {
      this.tracker.applyTask(await this.getTask(this.context.requestOptions));
      const remote = this.tracker.remoteState();
      if (isTerminalState(remote) && remote !== 'canceled') this.tracker.clearLocalCancel();
    } catch {
      // Keep the local cancellation.
    }
  }
}
