/**
 * HTTP client for a remote Weft server. Communicates over the REST API
 * exposed by {@link handleRequest}.
 *
 * Implements the same {@link WeftClient} interface as {@link LocalClient},
 * so switching from server mode to library mode is a constructor change.
 *
 * @module client/index
 */

export {
  WorkflowCancelledEvent,
  WorkflowCompletedEvent,
  WorkflowFailedEvent,
  WorkflowResumedEvent,
  WorkflowStartedEvent,
  WorkflowSuspendedEvent,
  WorkflowTeardownEvent,
  WorkflowTimedOutEvent,
} from '../core/events/workflow-events.ts';
export { isFaultCode, type FaultCode } from '../core/fault-code.ts';
export {
  WeftError,
  isWeftError,
  isWeftErrorCode,
  isWeftErrorLike,
  isWeftFault,
} from '../core/weft-error.ts';
export type { WeftErrorCode } from '../core/weft-error.ts';
export type { WeftClientStorage } from './client-storage.ts';
export type { WorkflowEventStreamOptions, WorkflowEventTransport } from './event-stream-options.ts';
export type { WorkflowEventTail } from './event-tail.ts';
export { HttpClient } from './http-client.ts';
export { HttpClientError } from './http-request.ts';
export type { HttpClientOptions } from './http-request.ts';
export type {
  ClientHandle,
  ClientScheduleHandle,
  ClientStartOptions,
  ClientStartOrSignalOptions,
  StartOrSignalOutcome,
  UpdateResult,
  WeftClient,
  WeftClientActivity,
} from './interface.ts';
export type { KnownWorkflowName, UnknownNameWhenRegistryEmpty } from './workflow-name-typing.ts';
