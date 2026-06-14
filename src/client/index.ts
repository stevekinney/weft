/**
 * HTTP client for a remote Weft server. Communicates over the REST API
 * exposed by {@link handleRequest}.
 *
 * Implements the same {@link WeftClient} interface as {@link LocalClient},
 * so switching from server mode to library mode is a constructor change.
 *
 * @module client/index
 */

export type { WorkflowEventTail } from './event-tail.ts';
export { HttpClient } from './http-client.ts';
export { HttpClientError } from './http-request.ts';
export type { HttpClientOptions } from './http-request.ts';
export type {
  ClientHandle,
  ClientScheduleHandle,
  ClientStartOptions,
  UpdateResult,
  WeftClient,
  WeftClientActivity,
} from './interface.ts';
export type { KnownWorkflowName, UnknownNameWhenRegistryEmpty } from './workflow-name-typing.ts';
