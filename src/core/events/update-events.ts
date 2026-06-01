/**
 * Fired on the {@link Engine} when an update request is received for a workflow.
 * Contains the `updateId`, `name`, and `payload`. Precedes a corresponding
 * {@link UpdateCompletedEvent} once the workflow handler processes the update.
 *
 * @example
 * ```ts
 * import { Engine, UpdateReceivedEvent } from '@lostgradient/weft';
 *
 * const engine = new Engine();
 * engine.addEventListener('update:received', (e: Event) => {
 *   const ev = e as UpdateReceivedEvent;
 *   console.log('update', ev.name, 'received for', ev.workflowId, '(id:', ev.updateId, ')');
 * });
 * ```
 */
export class UpdateReceivedEvent extends Event {
  static readonly type = 'update:received' as const;
  readonly updateId: string;
  readonly workflowId: string;
  readonly name: string;
  readonly payload: unknown;

  constructor(updateId: string, workflowId: string, name: string, payload: unknown) {
    super(UpdateReceivedEvent.type);
    this.updateId = updateId;
    this.workflowId = workflowId;
    this.name = name;
    this.payload = payload;
  }
}

/**
 * Fired on the {@link Engine} when a workflow update handler returns a result
 * (or throws an error). Check `e.error` to distinguish success from failure;
 * on success, `e.result` holds the handler's return value.
 *
 * @example
 * ```ts
 * import { Engine, UpdateCompletedEvent } from '@lostgradient/weft';
 *
 * const engine = new Engine();
 * engine.addEventListener('update:completed', (e: Event) => {
 *   const ev = e as UpdateCompletedEvent;
 *   if (ev.error) {
 *     console.error('update', ev.name, 'failed:', ev.error);
 *   } else {
 *     console.log('update', ev.name, 'result:', ev.result);
 *   }
 * });
 * ```
 */
export class UpdateCompletedEvent extends Event {
  static readonly type = 'update:completed' as const;
  readonly updateId: string;
  readonly workflowId: string;
  readonly name: string;
  readonly result: unknown;
  readonly error: string | undefined;

  constructor(updateId: string, workflowId: string, name: string, result: unknown, error?: string) {
    super(UpdateCompletedEvent.type);
    this.updateId = updateId;
    this.workflowId = workflowId;
    this.name = name;
    this.result = result;
    this.error = error;
  }
}
