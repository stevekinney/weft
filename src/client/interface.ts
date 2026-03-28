/**
 * Shared client interface for Weft. Both {@link LocalClient} and
 * {@link HttpClient} implement this contract so switching between
 * library mode and server mode is a constructor change, not an API change.
 *
 * @module client/interface
 */

import type { BudgetPolicyOptions } from '../ai/budget-policy.ts';
import type { TypedEventTarget, WeftEventMap } from '../core/events.ts';
import type {
  CoordinatedUpdateResult,
  ListFilter,
  PaginatedResult,
  SearchAttributeValue,
  StartOptions,
  SubmitReviewOptions,
  WorkflowEvent,
  WorkflowState,
  WorkflowSummary,
} from '../core/types.ts';

// ---------------------------------------------------------------------------
// Client handle — lightweight reference to a running workflow
// ---------------------------------------------------------------------------

/**
 * A reference to a workflow that provides convenience methods.
 *
 * Extends {@link TypedEventTarget} so callers can observe workflow lifecycle
 * events with the same `addEventListener` / `removeEventListener` API in both
 * library mode (events flow through `EventTarget` directly) and server mode
 * (events are bridged over WebSocket).
 */
export interface ClientHandle extends TypedEventTarget<WeftEventMap> {
  /** The workflow's unique identifier. */
  readonly id: string;

  /** Resolves when the workflow completes (or rejects on failure). */
  result(): Promise<unknown>;

  /** Cancel this workflow. */
  cancel(): Promise<void>;

  /** Send a named signal with an optional payload. */
  signal(name: string, payload?: unknown): Promise<void>;

  /** Submit a synchronous update and return the handler's result. */
  update(name: string, payload?: unknown, options?: { timeout?: number }): Promise<unknown>;

  /** Query a named read-only accessor on the running workflow. */
  query(name: string): Promise<unknown>;
}

// ---------------------------------------------------------------------------
// Update result (subset of internal UpdateResponse)
// ---------------------------------------------------------------------------

/** Result of a coordinated update request. */
export type UpdateResult = {
  updateId: string;
  result?: unknown;
  error?: string;
} | null;

// ---------------------------------------------------------------------------
// WeftClient interface
// ---------------------------------------------------------------------------

/** Operations shared by both in-process and HTTP clients. */
export interface WeftClient {
  /** Start a new workflow and return a handle to it. */
  start(type: string, input: unknown, options?: StartOptions): Promise<ClientHandle>;

  /** Get the full persisted state of a workflow, or `null` if not found. */
  get(id: string): Promise<WorkflowState | null>;

  /** List workflows with optional filtering and pagination. */
  list(filter?: ListFilter): Promise<PaginatedResult<WorkflowSummary>>;

  /** Cancel a running workflow. */
  cancel(id: string): Promise<void>;

  /** Send a named signal to a workflow. */
  signal(id: string, name: string, payload?: unknown): Promise<void>;

  /** Query a named read-only accessor on a running workflow. */
  query(id: string, name: string): Promise<unknown>;

  /** Submit a synchronous update to a running workflow. */
  update(
    id: string,
    name: string,
    payload?: unknown,
    options?: { timeout?: number },
  ): Promise<unknown>;

  /** Resume a failed or timed-out workflow. */
  resume(id: string): Promise<ClientHandle>;

  /** Recover all interrupted workflows. */
  recoverAll(): Promise<ClientHandle[]>;

  /** Force-timeout a workflow. */
  timeout(id: string): Promise<void>;

  /** Get search attributes for a workflow. */
  getAttributes(id: string): Promise<Record<string, SearchAttributeValue> | null>;

  /** Set search attributes on a workflow. */
  setAttributes(id: string, attributes: Record<string, SearchAttributeValue>): Promise<void>;

  /** Get the event history for a workflow. */
  getEvents(id: string): Promise<WorkflowEvent[]>;

  /** List pending human review requests. */
  listReviews(): Promise<Array<Record<string, unknown>>>;

  /** Submit a decision for a pending review. */
  submitReview(reviewId: string, options: SubmitReviewOptions): Promise<void>;

  /** Set an organization-level budget policy. */
  setBudgetPolicy(options: BudgetPolicyOptions): Promise<void>;

  /** Submit a coordinated update and wait for the result. */
  submitCoordinatedUpdate(
    id: string,
    name: string,
    payload?: unknown,
    options?: { timeout?: number; idempotencyKey?: string },
  ): Promise<CoordinatedUpdateResult>;

  /** Retrieve the result of a previously submitted coordinated update. */
  getUpdateResult(updateId: string): Promise<UpdateResult>;
}
