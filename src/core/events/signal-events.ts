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
 * engine.addEventListener('signal:received', (e: Event) => {
 *   const ev = e as SignalReceivedEvent;
 *   console.log(ev.workflowId, 'received signal', ev.signalName);
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
 * Fired on the {@link Engine} when a pending `waitForSignal` operation in a
 * workflow is resolved by the delivered signal. Emitted after the signal
 * unblocks the workflow and resumes execution.
 *
 * @example
 * ```ts
 * import { Engine, SignalDeliveredEvent } from '@lostgradient/weft';
 *
 * const engine = new Engine();
 * engine.addEventListener('signal:delivered', (e: Event) => {
 *   const ev = e as SignalDeliveredEvent;
 *   console.log('signal', ev.signalName, 'delivered to', ev.workflowId);
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
