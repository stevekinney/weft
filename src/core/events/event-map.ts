import type { ReviewCompletedEvent, ReviewRequestedEvent } from '../review/events.ts';
import type {
  ActivityAsyncPendingEvent,
  ActivityCompletedEvent,
  ActivityFailedEvent,
  ActivityStartedEvent,
  TaskResultDeadLetteredEvent,
} from './activity-events.ts';
import type { AttributesChangedEvent } from './attribute-events.ts';
import type { ScheduleFiredEvent, ScheduleMissedFireEvent } from './schedule-events.ts';
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
  WorkflowDefinitionRegisteredEvent,
  WorkflowFailedEvent,
  WorkflowRecoverySkippedEvent,
  WorkflowResumedEvent,
  WorkflowStartedEvent,
  WorkflowSuspendedEvent,
  WorkflowTeardownEvent,
  WorkflowTimedOutEvent,
} from './workflow-events.ts';

/**
 * Record mapping each event-name string the {@link Engine} dispatches to its
 * corresponding typed `Event` subclass.
 *
 * @example
 * ```ts
 * import { Engine, type WeftEventMap } from '@lostgradient/weft';
 *
 * function listenAll(engine: Engine) {
 *   engine.addEventListener('workflow:completed', (event) => {
 *     const completed: WeftEventMap['workflow:completed'] = event;
 *     console.log('done', completed.workflowId, completed.result);
 *   });
 * }
 * void listenAll;
 * ```
 */
export type WeftEventMap = {
  'workflow:definition-registered': WorkflowDefinitionRegisteredEvent;
  'workflow:started': WorkflowStartedEvent;
  'workflow:completed': WorkflowCompletedEvent;
  'workflow:failed': WorkflowFailedEvent;
  'workflow:cancelled': WorkflowCancelledEvent;
  'workflow:timed-out': WorkflowTimedOutEvent;
  'workflow:resumed': WorkflowResumedEvent;
  'workflow:suspended': WorkflowSuspendedEvent;
  'workflow:recovery-skipped': WorkflowRecoverySkippedEvent;
  'workflow:teardown': WorkflowTeardownEvent;
  'activity:started': ActivityStartedEvent;
  'activity:completed': ActivityCompletedEvent;
  'activity:failed': ActivityFailedEvent;
  'activity:async-pending': ActivityAsyncPendingEvent;
  'task:dead-lettered': TaskResultDeadLetteredEvent;
  'signal:received': SignalReceivedEvent;
  'signal:delivered': SignalDeliveredEvent;
  'schedule:fired': ScheduleFiredEvent;
  'human-review:requested': ReviewRequestedEvent;
  'human-review:completed': ReviewCompletedEvent;
  'attributes:changed': AttributesChangedEvent;
  'schedule:missed-fire': ScheduleMissedFireEvent;
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
 * addTypedListener(engine);
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
