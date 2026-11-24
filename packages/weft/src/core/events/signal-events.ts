/**
 * Fired on the {@link Engine} when a signal is delivered to a workflow via
 * `engine.signal` or `handle.signal`. Read `e.workflowId`, `e.signalName`,
 * and `e.payload` to observe signal delivery.
 *
 * @example
 * ```ts
 * import { Engine, SignalReceivedEvent } from '@lostgradient/weft';
 *
 * const engine = new Engine();
 * engine.addEventListener(SignalReceivedEvent.type, (event) => {
 *   console.log(event.workflowId, 'received signal', event.signalName);
 * });
 * ```
 */
export class SignalReceivedEvent extends Event {
  static readonly type = 'signal:received' as const;
  readonly workflowId: string;
  readonly signalName: string;
  readonly payload: unknown;

  constructor(workflowId: string, signalName: string, payload: unknown) {
    super(SignalReceivedEvent.type);
    this.workflowId = workflowId;
    this.signalName = signalName;
    this.payload = payload;
  }
}

/**
 * Fired on the {@link Engine} when a workflow begins waiting for a signal that
 * has not arrived, once the engine has recorded the name in the workflow's
 * persisted `WorkflowState.waitingForSignals`. A signal already buffered when
 * `waitForSignal` runs completes the wait at once and fires no
 * `signal:waiting`, and a wait recovered after a restart, whose name the
 * persisted record already lists, does not fire it again.
 *
 * @example
 * ```ts
 * import { Engine, SignalWaitingEvent } from '@lostgradient/weft';
 *
 * const engine = new Engine();
 * engine.addEventListener(SignalWaitingEvent.type, (event) => {
 *   console.log(event.workflowId, 'is waiting for', event.signalName);
 * });
 * ```
 */
export class SignalWaitingEvent extends Event {
  static readonly type = 'signal:waiting' as const;
  readonly workflowId: string;
  readonly signalName: string;

  constructor(workflowId: string, signalName: string) {
    super(SignalWaitingEvent.type);
    this.workflowId = workflowId;
    this.signalName = signalName;
  }
}

/**
 * Fired on the {@link Engine} when a pending `waitForSignal` operation in a
 * workflow is resolved by the delivered signal. Emitted after the signal
 * unblocks the workflow and resumes execution.
 *
 * @example
 * ```ts
 * import { Engine, SignalDeliveredEvent } from '@lostgradient/weft';
 *
 * const engine = new Engine();
 * engine.addEventListener(SignalDeliveredEvent.type, (event) => {
 *   console.log('signal', event.signalName, 'delivered to', event.workflowId);
 * });
 * ```
 */
export class SignalDeliveredEvent extends Event {
  static readonly type = 'signal:delivered' as const;
  readonly workflowId: string;
  readonly signalName: string;

  constructor(workflowId: string, signalName: string) {
    super(SignalDeliveredEvent.type);
    this.workflowId = workflowId;
    this.signalName = signalName;
  }
}
