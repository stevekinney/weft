/**
 * Types and errors for the A2A peer client ({@link createA2APeerClient}).
 *
 * @module a2a/peer-client-types
 */

/** Why a peer call failed, as a code a caller can branch on. */
export type A2APeerErrorCode =
  /** The Agent Card could not be fetched or is not a usable card. */
  | 'card-unavailable'
  /** The card marks an extension `required` that this client does not support. */
  | 'extension-support-required'
  /** No interface on the card speaks A2A 1.0 over JSON-RPC, or the peer refused the version. */
  | 'version-not-supported'
  /** The peer cannot accept or produce the media types this client uses. */
  | 'content-type-not-supported'
  /** The client's egress policy, or the card's origin rule, refused a URL. */
  | 'egress-denied'
  /** The peer answered 401 or 403 and the client could not obtain better credentials. */
  | 'unauthorized'
  /** The network failed, the peer answered 5xx or 429, or one request timed out. */
  | 'unreachable'
  /** The task did not settle within the client's overall task timeout. */
  | 'timeout'
  /** The peer does not know the task. */
  | 'task-not-found'
  /** The peer cannot cancel the task, usually because it already finished. */
  | 'task-not-cancelable'
  /** The peer broke the protocol, or answered with an error this client does not model. */
  | 'protocol';

/** An error from the A2A peer client; {@link A2APeerError.code} says which kind. */
export class A2APeerError extends Error {
  /** The failure class. */
  readonly code: A2APeerErrorCode;
  /** Whether repeating the same request could succeed (network, 5xx, 429, per-request timeout). */
  readonly retryable: boolean;

  /** Builds an error for `code`; `retryable` defaults to `false`. */
  constructor(
    code: A2APeerErrorCode,
    message: string,
    options: { readonly cause?: unknown; readonly retryable?: boolean } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'A2APeerError';
    this.code = code;
    this.retryable = options.retryable ?? false;
  }
}

/**
 * The peer's card marks an extension `required` that this client does not implement, so the
 * client refuses to call the peer rather than send messages the peer would misread.
 */
export class ExtensionSupportRequiredError extends A2APeerError {
  /** The required extension URIs that are not in `supportedExtensions`. */
  readonly uris: readonly string[];

  /** Builds the error for the unsupported required `uris`. */
  constructor(uris: readonly string[]) {
    super(
      'extension-support-required',
      `The peer requires extensions this client does not support: ${uris.join(', ')}.`,
    );
    this.name = 'ExtensionSupportRequiredError';
    this.uris = uris;
  }
}

/** A task's state, with the A2A `TASK_STATE_` prefix dropped. */
export type A2APeerTaskState =
  | 'submitted'
  | 'working'
  | 'input-required'
  | 'auth-required'
  | 'completed'
  | 'failed'
  | 'canceled'
  | 'rejected';

/** The states in which a task will not progress without a new message from the caller. */
export type A2APeerStopState = Exclude<A2APeerTaskState, 'submitted' | 'working'>;

/** Where a peer's content came from: the peer's card identity and the task that produced it. */
export interface A2APeerProvenance {
  /** The peer card's `name`. */
  readonly agentName: string;
  /** The peer card's `version`. */
  readonly agentVersion: string;
  /** The URL the card was read from. */
  readonly cardUrl: string;
  /** The task's identifier on the peer; empty when the peer answered with a bare message. */
  readonly taskId: string;
}

/**
 * One part of a peer's artifact, mapped for use as untrusted input. Nothing is fetched and no
 * binary content is carried: a `url` part stays a reference, and a `raw` part is `omitted`.
 */
export type A2APeerPart =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'data'; readonly data: unknown }
  | {
      readonly kind: 'reference';
      readonly url: string;
      readonly mediaType: string;
      readonly filename: string;
    }
  | {
      readonly kind: 'omitted';
      readonly mediaType: string;
      readonly filename: string;
      readonly reason: 'binary' | 'too-large';
    };

/** An artifact a peer produced. Its content is untrusted input. */
export interface A2APeerArtifact {
  /** The peer's identifier for the artifact. */
  readonly artifactId: string;
  /** The artifact's name, as the peer gave it. */
  readonly name: string;
  /** The artifact's description, as the peer gave it. */
  readonly description: string;
  /** The mapped parts, in order. */
  readonly parts: readonly A2APeerPart[];
}

/** A snapshot of a peer task's progress, delivered to `onUpdate`. */
export interface A2APeerUpdate {
  /** The task's current state. */
  readonly state: A2APeerTaskState;
  /** The task's identifier on the peer. */
  readonly taskId: string;
  /** The task's context identifier. */
  readonly contextId: string;
  /** The text of the status message, when the peer sent one. Untrusted. */
  readonly message: string;
}

/**
 * Where a peer task stopped. `completed`, `failed`, `canceled` and `rejected` are terminal;
 * `input-required` and `auth-required` leave the remote task open, and a new `send` with the same
 * `taskId` continues it. Everything in `message` and `artifacts` is untrusted input from the
 * peer named by `provenance`.
 */
export interface A2APeerOutcome {
  /** Always `true`: the content below came from another agent. */
  readonly untrusted: true;
  /** The state the task stopped in. */
  readonly state: A2APeerStopState;
  /** The task's identifier on the peer; empty when the peer answered with a bare message. */
  readonly taskId: string;
  /** The task's context identifier. */
  readonly contextId: string;
  /** The peer that produced the content. */
  readonly provenance: A2APeerProvenance;
  /** The text of the final status or reply message. */
  readonly message: string;
  /** The task's artifacts, mapped without fetching or carrying binary content. */
  readonly artifacts: readonly A2APeerArtifact[];
  /**
   * Set when this client canceled the task: `true` when the peer confirmed `CancelTask`, `false`
   * when the task is canceled locally only because the peer refused or could not be reached.
   */
  readonly cancelConfirmed?: boolean | undefined;
  /** Why the cancel was not confirmed, when `cancelConfirmed` is `false`. */
  readonly cancelError?: string | undefined;
}

/** A running (or stopped) task on a peer. */
export interface A2APeerTask {
  /** The task's identifier on the peer; empty when the peer answered with a bare message. */
  readonly taskId: string;
  /** The task's context identifier. */
  readonly contextId: string;
  /** The peer that owns the task. */
  readonly provenance: A2APeerProvenance;
  /** The latest state this client has seen, or `canceled` once it canceled the task. */
  state(): A2APeerTaskState;
  /**
   * Resolves when the task stops: terminal, or waiting for input or authentication. Streams
   * when the card advertises streaming, reconnecting with `SubscribeToTask` after a dropped
   * stream, and polls `GetTask` otherwise. Rejects with an {@link A2APeerError} when the peer
   * stays unreachable or the task timeout passes. Cached: calling it again returns the same
   * outcome.
   */
  result(): Promise<A2APeerOutcome>;
  /**
   * Sends `CancelTask` and resolves with a locally terminal outcome. When the peer refuses or
   * cannot be reached the task is still `canceled` here, with `cancelConfirmed: false`.
   */
  cancel(reason?: string): Promise<A2APeerOutcome>;
}

/** One message to a peer. */
export interface A2APeerSendRequest {
  /** The message text. */
  readonly text: string;
  /** Continue this existing task (after `input-required` or `auth-required`). */
  readonly taskId?: string | undefined;
  /** Continue this context; required by some peers when `taskId` is set. */
  readonly contextId?: string | undefined;
  /**
   * The message's identifier, for a caller that must be able to repeat the send. The default is a
   * fresh random one, fixed before the first attempt. Passing the same identifier again, for
   * example from a replayed tool call after a restart, is the retry the A2A spec describes: a
   * peer that keeps its message history answers with the task the first send created instead of
   * starting another. Must be a non-empty string.
   */
  readonly messageId?: string | undefined;
  /** Aborting it cancels the remote task; the returned task's `result()` then settles `canceled`. */
  readonly signal?: AbortSignal | undefined;
  /** Called with each state change this client observes. */
  readonly onUpdate?: ((update: A2APeerUpdate) => void) | undefined;
}

/** A request to follow a task that already exists on a peer, without sending a message. */
export interface A2APeerAttachRequest {
  /** The task's identifier on the peer. */
  readonly taskId: string;
  /** The task's context identifier, when the caller kept it. */
  readonly contextId?: string | undefined;
  /** Aborting it cancels the remote task, as it does for `send`. */
  readonly signal?: AbortSignal | undefined;
  /** Called with each state change this client observes. */
  readonly onUpdate?: ((update: A2APeerUpdate) => void) | undefined;
}

/** What a client learned from a peer's Agent Card after validating it. */
export interface A2APeerCard {
  /** The card's `name`. */
  readonly name: string;
  /** The card's `version`. */
  readonly version: string;
  /** The card's `description`. */
  readonly description: string;
  /** The URL the card was read from. */
  readonly cardUrl: string;
  /** The URL of the interface the client selected. */
  readonly interfaceUrl: string;
  /** Whether the client streams (the card advertised `capabilities.streaming`) or polls. */
  readonly streaming: boolean;
  /** The extension URIs the client activates on every request. */
  readonly activeExtensions: readonly string[];
}

/** A client for one A2A peer, addressed by Agent Card URL. */
export interface A2APeerClient {
  /**
   * The validated card, from the cache while it is fresh. Rejects with an
   * {@link ExtensionSupportRequiredError} when the card requires an unsupported extension,
   * with `version-not-supported` when it lists no usable interface, and with
   * `content-type-not-supported` when it accepts no `text/plain` input.
   */
  card(options?: { readonly refresh?: boolean | undefined }): Promise<A2APeerCard>;
  /** Sends a message and resolves once the peer has accepted it and named the task. */
  send(request: A2APeerSendRequest): Promise<A2APeerTask>;
  /**
   * Follows a task the peer already holds, without sending a message: a caller that kept the
   * `taskId` from an earlier `send` (a restarted process, for example) picks the task up again.
   * Resolves once the peer has reported the task's current state, so a task that already stopped
   * is returned stopped. Rejects with `task-not-found` when the peer no longer knows the task.
   */
  attach(request: A2APeerAttachRequest): Promise<A2APeerTask>;
}
