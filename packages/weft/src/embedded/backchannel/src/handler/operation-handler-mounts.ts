import type {
  DispatchResult,
  ErasedOperation,
  executeSubscription,
  OperationRegistry,
} from '../operation-catalog.ts';
import type { Principal } from '../principal.ts';
import { GENERIC_SUBSCRIPTION_ROUTE_PREFIX } from '../route-model.ts';

/**
 * One registered operation as a mounted adapter sees it: what it needs to
 * describe the operation in its own protocol (an MCP bridge lists tools from
 * these), and nothing that would let it run the operation outside the pipeline.
 */
export type OperationHandlerMountOperation = Pick<
  ErasedOperation,
  | 'name'
  | 'summary'
  | 'description'
  | 'mcpExposable'
  | 'mcpTool'
  | 'destructive'
  | 'inputSchema'
  | 'outputSchema'
  | 'unknownKeyPolicy'
  | 'kind'
>;

/**
 * Which transport a mounted adapter's dispatch is attributed to. `http-rest` is the default;
 * `mcp` admits exactly the operations the catalog marks `mcpExposable`.
 */
export type OperationHandlerMountDispatchOptions = {
  /** The transport the dispatch runs as: `http-rest` by default, or `mcp`. */
  readonly transport?: 'http-rest' | 'mcp';
};

/**
 * What an adapter mounted on the operation handler receives with each request.
 *
 * An adapter translates its protocol and the catalog executes: `dispatch` and
 * `subscribe` run the full catalog pipeline (transport, access policy,
 * parsing, `authorize`, output validation) as the resolved `principal`, over
 * the `http-rest` transport unless the adapter names `mcp`. An adapter that
 * bypassed them and reached into the host directly would also bypass access
 * policy.
 */
export type OperationHandlerMountContext = {
  /** The caller `authenticate` resolved, or the anonymous principal on a public path. */
  readonly principal: Principal;
  /** Every registered operation, in registration order. */
  readonly operations: ReadonlyArray<OperationHandlerMountOperation>;
  /** Runs one unary catalog operation through the full pipeline, as this principal. */
  readonly dispatch: (
    operationName: string,
    input: unknown,
    options?: OperationHandlerMountDispatchOptions,
  ) => Promise<DispatchResult<unknown>>;
  /** Runs one `subscription` catalog operation through the full pipeline, as this principal. */
  readonly subscribe: (
    operationName: string,
    input: unknown,
    options?: OperationHandlerMountDispatchOptions,
  ) => ReturnType<typeof executeSubscription>;
};

/**
 * A protocol adapter (A2A, AG-UI, an MCP bridge) mounted on the handler. It
 * is not a catalog operation and appears in none of the discovery documents.
 */
export type OperationHandlerMount = {
  /**
   * Path prefix this adapter owns, for example `/a2a`. It handles a request
   * whose path equals the prefix or begins with `<prefix>/`.
   */
  readonly pathPrefix: string;
  /**
   * Exact paths, anywhere in the URL space, that skip `authenticate`, such as
   * `/.well-known/agent-card.json`. The mount also handles them.
   */
  readonly publicPaths?: ReadonlyArray<string>;
  /**
   * Decides, for a path under `pathPrefix`, whether it skips `authenticate`: for routes a fixed
   * list cannot name, such as an Agent Card at `<prefix>/<agent>/.well-known/agent-card.json`
   * for an agent published after construction. It is consulted only for paths the prefix covers,
   * so a mount cannot make another route public.
   */
  readonly isPublicPath?: (pathname: string) => boolean;
  /** Answers a request under the mount's path prefix. */
  readonly fetch: (request: Request, context: OperationHandlerMountContext) => Promise<Response>;
};

/**
 * Every path the handler answers itself. A mount prefix may not overlap one,
 * and a mount's public path may not be one or sit beneath one.
 */
export const OPERATION_HANDLER_CATALOG_ROUTE_PATHS: ReadonlyArray<string> = [
  '/jsonrpc',
  GENERIC_SUBSCRIPTION_ROUTE_PREFIX,
  '/openapi.json',
  '/openrpc.json',
  '/asyncapi.json',
  '/v1/health',
];

/** Whether `path` is `prefix` or lies beneath it at a segment boundary. */
export function isAtOrUnder(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

function overlaps(left: string, right: string): boolean {
  return isAtOrUnder(left, right) || isAtOrUnder(right, left);
}

function stripTrailingSlashes(path: string): string {
  return path.length > 1 ? path.replace(/\/+$/, '') : path;
}

function assertMountPath(path: string, description: string): string {
  const normalized = stripTrailingSlashes(path);
  if (!/^\/[^\s?#]+$/.test(normalized)) {
    throw new Error(
      `createOperationHandler: ${description} ${JSON.stringify(path)} must be an absolute path ` +
        'with no query or fragment, and cannot be the root',
    );
  }
  return normalized;
}

export type ResolvedMounts = {
  /** The mount that handles `pathname`, if any. */
  readonly match: (pathname: string) => OperationHandlerMount | undefined;
  /** Every mount public path, normalized. */
  readonly publicPaths: ReadonlySet<string>;
  /** Whether `pathname` skips authentication: a public path, or one its mount's predicate passes. */
  readonly isPublic: (pathname: string) => boolean;
};

/**
 * The paths the handler itself answers without authentication unless the host
 * says otherwise: health and the three discovery documents.
 */
export const DEFAULT_OPERATION_HANDLER_PUBLIC_PATHS: ReadonlyArray<string> = [
  '/v1/health',
  '/openapi.json',
  '/openrpc.json',
  '/asyncapi.json',
];

/**
 * Validate the handler's own `publicPaths` once, at construction, with the
 * rules a mount's `publicPaths` follow: an entry is an absolute path that
 * names a route the handler serves exactly, a fixed route or
 * `/v1/subscriptions/<name>` for a registered subscription (anything else is
 * inert and almost certainly a typo). A mount can never claim such a path, because a mount
 * prefix or public path that equals or lies beneath a catalog route is refused
 * at construction, so an unauthenticated path always has exactly one owner.
 */
export function resolveHandlerPublicPaths(
  paths: ReadonlyArray<string>,
  registry: OperationRegistry,
): ReadonlySet<string> {
  const resolved = new Set<string>();
  for (const path of paths) {
    const normalized = assertMountPath(path, 'publicPaths entry');
    if (!servesExactly(normalized, registry)) {
      throw new Error(
        `createOperationHandler: publicPaths entry "${normalized}" is not a route the handler serves. ` +
          `Use one of ${FIXED_ROUTE_PATHS.join(', ')}, or ${GENERIC_SUBSCRIPTION_ROUTE_PREFIX}/<name> ` +
          'for a registered subscription operation',
      );
    }
    resolved.add(normalized);
  }
  return resolved;
}

const FIXED_ROUTE_PATHS = OPERATION_HANDLER_CATALOG_ROUTE_PATHS.filter(
  (route) => route !== GENERIC_SUBSCRIPTION_ROUTE_PREFIX,
);

/** A fixed route, or the subscription route for an operation that is registered. */
function servesExactly(path: string, registry: OperationRegistry): boolean {
  if (FIXED_ROUTE_PATHS.includes(path)) return true;
  const subscriptionPrefix = `${GENERIC_SUBSCRIPTION_ROUTE_PREFIX}/`;
  if (!path.startsWith(subscriptionPrefix)) return false;
  return registry.get(path.slice(subscriptionPrefix.length))?.kind === 'subscription';
}

type NormalizedMount = {
  readonly mount: OperationHandlerMount;
  readonly pathPrefix: string;
  readonly publicPaths: ReadonlyArray<string>;
};

/**
 * Validate the mounts once, at construction, the way `createOperationRegistry`
 * rejects duplicate operation names: an adapter must not shadow a native
 * route or another adapter, and an unauthenticated path must have exactly one
 * owner.
 */
export function resolveMounts(mounts: ReadonlyArray<OperationHandlerMount>): ResolvedMounts {
  const normalized: NormalizedMount[] = mounts.map((mount) => ({
    mount,
    pathPrefix: assertMountPath(mount.pathPrefix, 'mount pathPrefix'),
    publicPaths: (mount.publicPaths ?? []).map((path) =>
      assertMountPath(path, 'mount publicPaths entry'),
    ),
  }));

  for (const [index, entry] of normalized.entries()) {
    assertPrefixIsFree(entry, normalized.slice(0, index));
    assertPublicPathsAreFree(
      entry,
      normalized.filter((other) => other !== entry),
    );
  }

  const publicPaths = new Set(normalized.flatMap((entry) => entry.publicPaths));
  return {
    publicPaths,
    isPublic(pathname) {
      if (publicPaths.has(pathname)) return true;
      const owner = normalized.find((entry) => isAtOrUnder(pathname, entry.pathPrefix));
      return owner?.mount.isPublicPath?.(pathname) === true;
    },
    match(pathname) {
      for (const entry of normalized) {
        if (isAtOrUnder(pathname, entry.pathPrefix) || entry.publicPaths.includes(pathname)) {
          return entry.mount;
        }
      }
      return undefined;
    },
  };
}

function assertPrefixIsFree(entry: NormalizedMount, earlier: ReadonlyArray<NormalizedMount>): void {
  for (const route of OPERATION_HANDLER_CATALOG_ROUTE_PATHS) {
    if (overlaps(entry.pathPrefix, route)) {
      throw new Error(
        `createOperationHandler: mount pathPrefix "${entry.pathPrefix}" overlaps the catalog route "${route}"`,
      );
    }
  }
  for (const other of earlier) {
    if (overlaps(entry.pathPrefix, other.pathPrefix)) {
      throw new Error(
        `createOperationHandler: mount pathPrefix "${entry.pathPrefix}" overlaps the mount "${other.pathPrefix}"`,
      );
    }
  }
}

function assertPublicPathsAreFree(
  entry: NormalizedMount,
  others: ReadonlyArray<NormalizedMount>,
): void {
  for (const publicPath of entry.publicPaths) {
    for (const route of OPERATION_HANDLER_CATALOG_ROUTE_PATHS) {
      if (isAtOrUnder(publicPath, route)) {
        throw new Error(
          `createOperationHandler: mount publicPaths entry "${publicPath}" is the catalog route "${route}" or lies beneath it`,
        );
      }
    }
    for (const other of others) {
      if (isAtOrUnder(publicPath, other.pathPrefix) || other.publicPaths.includes(publicPath)) {
        throw new Error(
          `createOperationHandler: mount publicPaths entry "${publicPath}" of "${entry.pathPrefix}" belongs to the mount "${other.pathPrefix}"`,
        );
      }
    }
  }
}
