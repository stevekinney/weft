import type { Engine } from '../core/engine.ts';
import { WorkflowDefinitionRegisteredEvent, type WeftEventMap } from '../core/events.ts';
import { WeftError } from '../core/weft-error.ts';
import type { JsonRpcId } from '../server/json-rpc-protocol.ts';
import type { Principal } from '../server/principal.ts';
import { MCP_TOOLS_LIST_CHANGED_NOTIFICATION, requestIdKey, type McpResponse } from './protocol.ts';
import { isWorkflowSearchResourceUri, workflowResourceUri } from './resources.ts';
import { listMcpTools } from './tools.ts';

type NotificationTarget = (message: McpResponse | Record<string, unknown>) => void;

type PendingRequest = {
  readonly workflowId: string;
  readonly abortController: AbortController;
};

type ToolListSignatureEntry = readonly [
  name: string,
  title: string | undefined,
  description: string,
  inputSchemaJson: string,
];

/**
 * MCP lifecycle phase tracked for one session.
 *
 * @example
 * ```ts
 * import { type McpSessionPhase } from '@lostgradient/weft/mcp';
 *
 * const phase: McpSessionPhase = 'ready';
 * void phase;
 * ```
 */
export type McpSessionPhase = 'new' | 'initializing' | 'ready';

/**
 * Options for bounding remote MCP session lifetime and memory usage.
 *
 * @example
 * ```ts
 * import { createMcpSessionManager, type McpSessionManagerOptions } from '@lostgradient/weft/mcp';
 * import { Engine, MemoryStorage } from '@lostgradient/weft';
 *
 * await using storage = new MemoryStorage();
 * await using engine = new Engine({ storage });
 *
 * const options: McpSessionManagerOptions = {
 *   maximumSessions: 256,
 *   sessionIdleTimeoutMilliseconds: 15 * 60 * 1000,
 * };
 * const manager = createMcpSessionManager(engine, options);
 * void manager;
 * ```
 */
export type McpSessionManagerOptions = {
  readonly maximumSessions?: number;
  readonly sessionIdleTimeoutMilliseconds?: number;
  readonly currentTimeMilliseconds?: () => number;
};

export class McpSessionLimitExceededError extends WeftError<'McpSessionLimitExceededError'> {
  constructor() {
    super('McpSessionLimitExceededError', 'Too many MCP sessions');
  }
}

const RESOURCE_EVENT_NAMES = [
  'workflow:started',
  'workflow:completed',
  'workflow:failed',
  'workflow:cancelled',
  'workflow:timed-out',
  'workflow:resumed',
  'workflow:suspended',
  'signal:received',
  'signal:delivered',
  'attributes:changed',
  'update:received',
  'update:completed',
] as const satisfies ReadonlyArray<keyof WeftEventMap>;

/**
 * Mutable MCP session state. Remote HTTP sessions are created during
 * `initialize`; stdio creates one local session for the process lifetime.
 *
 * @example
 * ```ts
 * import { McpSessionManager, type McpSession } from '@lostgradient/weft/mcp';
 * import { Engine, MemoryStorage } from '@lostgradient/weft';
 *
 * await using storage = new MemoryStorage();
 * await using engine = new Engine({ storage });
 * await using manager = new McpSessionManager(engine);
 *
 * const session: McpSession = manager.create({ method: 'unauthenticated' });
 * session.notify('notifications/initialized');
 * ```
 */
export class McpSession {
  readonly id: string;
  readonly principal: Principal;
  /**
   * Per-session continuation secret minted at creation. The session {@link id} is
   * sent by the client on *every* continuation request (POST/GET/DELETE), so it is
   * routinely exposed to proxy and access logs and is not, by itself, a credential.
   * This token is the credential: it is disclosed to the creating client exactly
   * once — in the `initialize` response — and never echoed on a continuation
   * response. The HTTP transport requires it alongside the session id on every
   * continuation request for sessions whose principal carries no other
   * distinguishing secret (anonymous sessions under `authRequired: false`), so a
   * leaked session id alone cannot drive, read, or terminate another caller's
   * session. Authenticated sessions already re-present their credential per request
   * and do not gate on this token.
   */
  readonly token: string;
  phase: McpSessionPhase = 'new';
  protocolVersion = '2025-11-25';
  readonly subscriptions = new Set<string>();
  readonly createdAtMilliseconds: number;
  lastActivityMilliseconds: number;

  readonly #pendingRequests = new Map<string, PendingRequest>();
  readonly #cancelledRequestKeys = new Set<string>();
  readonly #targets = new Set<NotificationTarget>();

  constructor(id: string, principal: Principal, currentTimeMilliseconds = Date.now()) {
    this.id = id;
    this.principal = principal;
    this.token = crypto.randomUUID();
    this.createdAtMilliseconds = currentTimeMilliseconds;
    this.lastActivityMilliseconds = currentTimeMilliseconds;
  }

  /** Mark the session as active after a successful transport-level lookup. */
  touch(currentTimeMilliseconds = Date.now()): void {
    this.lastActivityMilliseconds = currentTimeMilliseconds;
  }

  /** True when this session has exceeded its idle timeout. */
  isIdleExpired(currentTimeMilliseconds: number, timeoutMilliseconds: number): boolean {
    return currentTimeMilliseconds - this.lastActivityMilliseconds > timeoutMilliseconds;
  }

  /** Track an in-flight request that started a workflow and can be cancelled. */
  trackRequest(requestId: unknown, workflowId: string): void {
    const key = requestIdKey(asJsonRpcId(requestId));
    if (key === undefined) return;
    this.#pendingRequests.set(key, { workflowId, abortController: new AbortController() });
  }

  /** Record cancellation for a tracked in-flight request and return its workflow id. */
  cancelRequest(requestId: unknown): string | undefined {
    const key = requestIdKey(asJsonRpcId(requestId));
    if (key === undefined) return undefined;
    const request = this.#pendingRequests.get(key);
    if (request === undefined) return undefined;
    this.#cancelledRequestKeys.add(key);
    request.abortController.abort();
    return request.workflowId;
  }

  /** True when an in-flight MCP request has received a cancellation notification. */
  isRequestCancelled(requestId: unknown): boolean {
    const key = requestIdKey(asJsonRpcId(requestId));
    return key !== undefined && this.#cancelledRequestKeys.has(key);
  }

  /** Abort signal for an in-flight MCP request, if it can be cancelled. */
  requestSignal(requestId: unknown): AbortSignal | undefined {
    const key = requestIdKey(asJsonRpcId(requestId));
    if (key === undefined) return undefined;
    return this.#pendingRequests.get(key)?.abortController.signal;
  }

  /** Stop tracking an in-flight request after it completes. */
  untrackRequest(requestId: unknown): void {
    const key = requestIdKey(asJsonRpcId(requestId));
    if (key === undefined) return;
    this.#pendingRequests.delete(key);
    this.#cancelledRequestKeys.delete(key);
  }

  /** Return the workflow associated with an in-flight MCP request. */
  workflowForRequest(requestId: unknown): string | undefined {
    const key = requestIdKey(asJsonRpcId(requestId));
    if (key === undefined) return undefined;
    return this.#pendingRequests.get(key)?.workflowId;
  }

  /** Attach a notification sink. Returns a cleanup function. */
  addTarget(target: NotificationTarget): () => void {
    this.#targets.add(target);
    return () => {
      this.#targets.delete(target);
    };
  }

  /** Broadcast a JSON-RPC notification to every live stream for this session. */
  notify(method: string, params?: Record<string, unknown>): void {
    const message =
      params === undefined ? { jsonrpc: '2.0', method } : { jsonrpc: '2.0', method, params };
    for (const target of this.#targets) {
      target(message);
    }
  }

  close(): void {
    this.#pendingRequests.clear();
    this.#cancelledRequestKeys.clear();
    this.subscriptions.clear();
    this.#targets.clear();
  }
}

function asJsonRpcId(value: unknown): JsonRpcId | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return undefined;
}

/**
 * Owns MCP sessions for a running server and translates engine events into
 * resource update notifications.
 *
 * @example
 * ```ts
 * import { McpSessionManager } from '@lostgradient/weft/mcp';
 * import { Engine, MemoryStorage } from '@lostgradient/weft';
 *
 * await using storage = new MemoryStorage();
 * await using engine = new Engine({ storage });
 * await using manager = new McpSessionManager(engine);
 *
 * manager.closeAll();
 * ```
 */
export class McpSessionManager implements AsyncDisposable {
  readonly #engine: Engine;
  readonly #sessions = new Map<string, McpSession>();
  readonly #resourceListener: EventListener;
  readonly #workflowDefinitionListener: EventListener;
  readonly #maximumSessions: number;
  readonly #sessionIdleTimeoutMilliseconds: number;
  readonly #currentTimeMilliseconds: () => number;
  #toolListSignature: ReadonlyArray<ToolListSignatureEntry>;

  constructor(engine: Engine, options: McpSessionManagerOptions = {}) {
    this.#engine = engine;
    this.#maximumSessions = options.maximumSessions ?? 1_024;
    this.#sessionIdleTimeoutMilliseconds = options.sessionIdleTimeoutMilliseconds ?? 30 * 60 * 1000;
    this.#currentTimeMilliseconds = options.currentTimeMilliseconds ?? Date.now;
    this.#toolListSignature = toolListSignature(engine);
    this.#resourceListener = (event) => {
      const workflowId = (event as { workflowId?: unknown }).workflowId;
      if (typeof workflowId !== 'string') return;
      this.#notifyWorkflowResourceUpdated(workflowId);
    };
    this.#workflowDefinitionListener = () => {
      this.#notifyToolListChangedIfNeeded();
    };
    for (const eventName of RESOURCE_EVENT_NAMES) {
      this.#engine.addEventListener(eventName, this.#resourceListener);
    }
    this.#engine.addEventListener(
      WorkflowDefinitionRegisteredEvent.type,
      this.#workflowDefinitionListener,
    );
  }

  /** Create and store a new session for a principal. */
  create(principal: Principal): McpSession {
    this.#deleteExpiredSessions();
    if (this.#sessions.size >= this.#maximumSessions) {
      throw new McpSessionLimitExceededError();
    }
    const now = this.#currentTimeMilliseconds();
    const session = new McpSession(crypto.randomUUID(), principal, now);
    this.#sessions.set(session.id, session);
    return session;
  }

  /** Store an externally-created session. Used by stdio. */
  add(session: McpSession): McpSession {
    this.#deleteExpiredSessions();
    if (this.#sessions.size >= this.#maximumSessions) {
      throw new McpSessionLimitExceededError();
    }
    session.touch(this.#currentTimeMilliseconds());
    this.#sessions.set(session.id, session);
    return session;
  }

  get(sessionId: string): McpSession | undefined {
    this.#deleteExpiredSessions();
    return this.#sessions.get(sessionId);
  }

  /** Mark a stored session active using the manager's clock. */
  touch(session: McpSession): void {
    if (this.#sessions.get(session.id) !== session) return;
    session.touch(this.#currentTimeMilliseconds());
  }

  delete(sessionId: string): void {
    this.#sessions.get(sessionId)?.close();
    this.#sessions.delete(sessionId);
  }

  closeAll(): void {
    for (const session of this.#sessions.values()) {
      session.close();
    }
    this.#sessions.clear();
  }

  #notifyWorkflowResourceUpdated(workflowId: string): void {
    const candidateUris = [
      workflowResourceUri(workflowId, 'state'),
      workflowResourceUri(workflowId, 'events'),
      workflowResourceUri(workflowId, 'checkpoints'),
    ];

    const now = this.#currentTimeMilliseconds();
    for (const session of this.#sessions.values()) {
      const subscribedUris = new Set<string>();
      for (const uri of candidateUris) {
        if (!session.subscriptions.has(uri)) continue;
        subscribedUris.add(uri);
      }
      const searchUris = [...session.subscriptions].filter(isWorkflowSearchResourceUri);
      for (const uri of searchUris) {
        subscribedUris.add(uri);
      }
      if (subscribedUris.size === 0) continue;
      session.touch(now);
      for (const uri of subscribedUris) {
        session.notify('notifications/resources/updated', { uri });
      }
    }
    this.#deleteExpiredSessions();
  }

  #notifyToolListChangedIfNeeded(): void {
    const nextSignature = toolListSignature(this.#engine);
    if (toolListSignaturesEqual(this.#toolListSignature, nextSignature)) return;
    this.#toolListSignature = nextSignature;

    const now = this.#currentTimeMilliseconds();
    for (const session of this.#sessions.values()) {
      if (session.phase !== 'ready') continue;
      session.touch(now);
      session.notify(MCP_TOOLS_LIST_CHANGED_NOTIFICATION);
    }
    this.#deleteExpiredSessions();
  }

  #deleteExpiredSessions(): void {
    const now = this.#currentTimeMilliseconds();
    for (const [sessionId, session] of this.#sessions) {
      if (!session.isIdleExpired(now, this.#sessionIdleTimeoutMilliseconds)) continue;
      session.close();
      this.#sessions.delete(sessionId);
    }
  }

  async [Symbol.asyncDispose](): Promise<void> {
    for (const eventName of RESOURCE_EVENT_NAMES) {
      this.#engine.removeEventListener(eventName, this.#resourceListener);
    }
    this.#engine.removeEventListener(
      WorkflowDefinitionRegisteredEvent.type,
      this.#workflowDefinitionListener,
    );
    this.closeAll();
  }
}

function toolListSignature(engine: Engine): ToolListSignatureEntry[] {
  return listMcpTools(engine).map((tool) => [
    tool.name,
    tool.title,
    tool.description,
    JSON.stringify(tool.inputSchema) ?? '',
  ]);
}

function toolListSignaturesEqual(
  left: ReadonlyArray<ToolListSignatureEntry>,
  right: ReadonlyArray<ToolListSignatureEntry>,
): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index++) {
    const leftEntry = left[index];
    const rightEntry = right[index];
    if (leftEntry === undefined || rightEntry === undefined) return false;
    if (
      leftEntry[0] !== rightEntry[0] ||
      leftEntry[1] !== rightEntry[1] ||
      leftEntry[2] !== rightEntry[2] ||
      leftEntry[3] !== rightEntry[3]
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Create an MCP session manager for an engine.
 *
 * @example
 * ```ts
 * import { createMcpSessionManager } from '@lostgradient/weft/mcp';
 * import { Engine, MemoryStorage } from '@lostgradient/weft';
 *
 * await using storage = new MemoryStorage();
 * await using engine = new Engine({ storage });
 * await using manager = createMcpSessionManager(engine);
 *
 * void manager;
 * ```
 */
export function createMcpSessionManager(
  engine: Engine,
  options?: McpSessionManagerOptions,
): McpSessionManager {
  return new McpSessionManager(engine, options);
}
