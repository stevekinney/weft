import type { ReviewCompletedEvent, ReviewRequestedEvent } from '../review/events.ts';
import type {
  ActivityAsyncPendingEvent,
  ActivityCompletedEvent,
  ActivityFailedEvent,
  ActivityStartedEvent,
} from './activity-events.ts';
import type { AttributesChangedEvent } from './attribute-events.ts';
import type { SignalDeliveredEvent, SignalReceivedEvent } from './signal-events.ts';
import type {
  AlertFiredEvent,
  AlertResolvedEvent,
  CheckpointSizeWarningEvent,
  CleanupWarningEvent,
  ConstraintViolatedEvent,
  DevelopmentWarningEvent,
  StorageSizeReportedEvent,
} from './system-events.ts';
import type { UpdateCompletedEvent, UpdateReceivedEvent } from './update-events.ts';
import type {
  WorkflowCancelledEvent,
  WorkflowCompletedEvent,
  WorkflowFailedEvent,
  WorkflowRecoverySkippedEvent,
  WorkflowResumedEvent,
  WorkflowStartedEvent,
  WorkflowTimedOutEvent,
} from './workflow-events.ts';

/**
 * Record mapping each event-name string the {@link Engine} dispatches to its
 * corresponding typed `Event` subclass. Use this as the type parameter for
 * {@link TypedEventTarget} to get type-safe `addEventListener` /
 * `removeEventListener` on the engine.
 *
 * @example
 * ```ts
 * import { Engine, type TypedEventTarget, type WeftEventMap } from '@lostgradient/weft';
 *
 * function listenAll(engine: Engine) {
 *   (engine as TypedEventTarget<WeftEventMap>)
 *     .addEventListener('workflow:completed', (e) => {
 *       console.log('done', e.workflowId, e.result);
 *     });
 * }
 * void listenAll;
 * ```
 */
export type WeftEventMap = {
  'workflow:started': WorkflowStartedEvent;
  'workflow:completed': WorkflowCompletedEvent;
  'workflow:failed': WorkflowFailedEvent;
  'workflow:cancelled': WorkflowCancelledEvent;
  'workflow:timed-out': WorkflowTimedOutEvent;
  'workflow:resumed': WorkflowResumedEvent;
  'workflow:recovery-skipped': WorkflowRecoverySkippedEvent;
  'activity:started': ActivityStartedEvent;
  'activity:completed': ActivityCompletedEvent;
  'activity:failed': ActivityFailedEvent;
  'activity:async-pending': ActivityAsyncPendingEvent;
  'signal:received': SignalReceivedEvent;
  'signal:delivered': SignalDeliveredEvent;
  'human-review:requested': ReviewRequestedEvent;
  'human-review:completed': ReviewCompletedEvent;
  'attributes:changed': AttributesChangedEvent;
  'update:received': UpdateReceivedEvent;
  'update:completed': UpdateCompletedEvent;
  'checkpoint:size-warning': CheckpointSizeWarningEvent;
  'development:warning': DevelopmentWarningEvent;
  'cleanup:warning': CleanupWarningEvent;
  'storage:size-reported': StorageSizeReportedEvent;
  'alert:fired': AlertFiredEvent;
  'alert:resolved': AlertResolvedEvent;
  'constraint:violated': ConstraintViolatedEvent;
};

/**
 * Typed version of the `EventTarget` interface that constrains
 * `addEventListener` and `removeEventListener` to the keys and event types
 * declared in `TEventMap`. The {@link Engine} implements this interface via
 * `WeftEventMap` so callers get IntelliSense on event names and strongly-typed
 * handler arguments.
 *
 * @example
 * ```ts
 * import { Engine, type TypedEventTarget, type WeftEventMap } from '@lostgradient/weft';
 *
 * function addTypedListener(target: TypedEventTarget<WeftEventMap>) {
 *   target.addEventListener('workflow:started', (e) => {
 *     console.log('started:', e.workflowId);
 *   });
 * }
 * const engine = new Engine();
 * addTypedListener(engine as TypedEventTarget<WeftEventMap>);
 * void engine;
 * ```
 */
export interface TypedEventTarget<TEventMap extends Record<string, Event>> {
  addEventListener<K extends keyof TEventMap & string>(
    type: K,
    listener: (event: TEventMap[K]) => void,
    options?: boolean | AddEventListenerOptions,
  ): void;
  addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions,
  ): void;
  removeEventListener<K extends keyof TEventMap & string>(
    type: K,
    listener: (event: TEventMap[K]) => void,
    options?: boolean | EventListenerOptions,
  ): void;
  removeEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | EventListenerOptions,
  ): void;
}
