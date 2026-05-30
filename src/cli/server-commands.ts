/**
 * `weft server health` and `weft server info` — operate/inspect commands for a
 * running Weft server.
 *
 * `health` probes the `/v1/health` meta endpoint and maps reachability to an
 * exit code (0 healthy, 1 unreachable). `--wait` polls until the server
 * responds or a timeout elapses, which deploy scripts use to block until a
 * freshly started server is ready.
 *
 * `info` reports the resolved server, its health, and a version-skew summary:
 * the count of operations the server advertises in `/openrpc.json` that this
 * CLI's bundled catalog does not know about, surfaced as "N additional
 * operations available via weft api".
 *
 * @module cli/server-commands
 */

import { resolveConnection } from '../connection.ts';
import { CATALOG_OPERATION_NAMES } from './generated/operation-client.generated.ts';
import { messageOf, prettyJson } from './output.ts';
import type { CommandOutput, ServerCommand } from './types.ts';

const HEALTH_POLL_INTERVAL_MS = 250;

/** Execute `weft server health` or `weft server info`. */
export async function executeServer(command: ServerCommand): Promise<CommandOutput> {
  let resolved: { server: URL; token: string | undefined };
  try {
    resolved = resolveServerConnection(command);
  } catch (error) {
    return {
      stdout: '',
      stderr: `server: connection error: ${messageOf(error)}`,
      exitCode: 2,
    };
  }
  const { server, token } = resolved;
  if (command.action === 'health') return executeServerHealth(command, server, token);
  return executeServerInfo(command, server, token);
}

function resolveServerConnection(command: ServerCommand): {
  server: URL;
  token: string | undefined;
} {
  const connection = resolveConnection({
    ...(command.server === undefined ? {} : { server: command.server }),
    ...(command.token === undefined ? {} : { token: command.token }),
    ...(command.profile === undefined ? {} : { profile: command.profile }),
  });
  return { server: connection.server, token: connection.token };
}

function metaEndpoint(server: URL, path: string): URL {
  const endpoint = new URL(server.toString());
  const basePath = endpoint.pathname.endsWith('/') ? endpoint.pathname : `${endpoint.pathname}/`;
  endpoint.pathname = `${basePath}${path}`.replaceAll(/\/+/g, '/');
  endpoint.search = '';
  endpoint.hash = '';
  return endpoint;
}

function authHeaders(token: string | undefined): Headers {
  const headers = new Headers();
  if (token !== undefined && token !== '') headers.set('authorization', `Bearer ${token}`);
  return headers;
}

type HealthResult =
  | { healthy: true; detail: string; connectionError: false }
  | { healthy: false; detail: string; connectionError: boolean };

async function probeHealth(server: URL, token: string | undefined): Promise<HealthResult> {
  try {
    const response = await fetch(metaEndpoint(server, 'v1/health'), {
      method: 'GET',
      headers: authHeaders(token),
    });
    if (!response.ok) {
      return {
        healthy: false,
        detail: `server returned status ${response.status}`,
        connectionError: false,
      };
    }
    return { healthy: true, detail: 'ok', connectionError: false };
  } catch (error) {
    return {
      healthy: false,
      detail: error instanceof Error ? error.message : String(error),
      connectionError: true,
    };
  }
}

async function executeServerHealth(
  command: ServerCommand,
  server: URL,
  token: string | undefined,
): Promise<CommandOutput> {
  const result = command.wait
    ? await waitForHealth(server, token, command.waitTimeoutMs)
    : await probeHealth(server, token);

  // Exit code 0: healthy; 1: unreachable/unhealthy response; 2: connection error (no response at all)
  const exitCode = result.healthy ? 0 : result.connectionError ? 2 : 1;

  if (command.json) {
    return {
      stdout: prettyJson({
        server: server.toString(),
        healthy: result.healthy,
        detail: result.detail,
      }),
      exitCode,
    };
  }

  if (result.healthy) {
    return {
      stdout: command.quiet ? '' : `${server.toString()} is healthy`,
      exitCode: 0,
    };
  }

  return {
    stdout: '',
    stderr: command.quiet ? '' : `${server.toString()} is unreachable: ${result.detail}`,
    exitCode,
  };
}

async function waitForHealth(
  server: URL,
  token: string | undefined,
  timeoutMs: number,
): Promise<HealthResult> {
  const deadline = Date.now() + timeoutMs;
  let last = await probeHealth(server, token);
  while (!last.healthy && Date.now() < deadline) {
    await Bun.sleep(HEALTH_POLL_INTERVAL_MS);
    last = await probeHealth(server, token);
  }
  return last;
}

type OpenRpcDocument = { readonly methods?: ReadonlyArray<{ readonly name?: unknown }> };

function isOpenRpcDocument(value: unknown): value is OpenRpcDocument {
  return typeof value === 'object' && value !== null;
}

async function fetchServerOperationNames(
  server: URL,
  token: string | undefined,
): Promise<ReadonlyArray<string> | undefined> {
  try {
    const response = await fetch(metaEndpoint(server, 'openrpc.json'), {
      method: 'GET',
      headers: authHeaders(token),
    });
    if (!response.ok) return undefined;
    const body = (await response.json()) as unknown;
    if (!isOpenRpcDocument(body) || !Array.isArray(body.methods)) return undefined;
    return body.methods
      .map((method) => (typeof method.name === 'string' ? method.name : undefined))
      .filter((name): name is string => name !== undefined);
  } catch {
    return undefined;
  }
}

function additionalServerOperations(
  serverOperationNames: ReadonlyArray<string> | undefined,
): ReadonlyArray<string> {
  if (serverOperationNames === undefined) return [];
  const knownNames = new Set<string>(CATALOG_OPERATION_NAMES);
  return serverOperationNames.filter((name) => !knownNames.has(name)).toSorted();
}

function formatServerInfoLines(
  server: URL,
  health: { healthy: boolean; detail: string },
  serverOperationNames: ReadonlyArray<string> | undefined,
  additionalOperations: ReadonlyArray<string>,
): string[] {
  const lines = [
    `Server:  ${server.toString()}`,
    `Health:  ${health.healthy ? 'ok' : `unreachable (${health.detail})`}`,
    `CLI catalog operations: ${CATALOG_OPERATION_NAMES.length}`,
  ];
  if (serverOperationNames === undefined) return lines;
  lines.push(`Server operations: ${serverOperationNames.length}`);
  if (additionalOperations.length > 0) {
    lines.push(
      `${additionalOperations.length} additional operations available via weft api:`,
      ...additionalOperations.map((name) => `  ${name}`),
    );
  }
  return lines;
}

async function executeServerInfo(
  command: ServerCommand,
  server: URL,
  token: string | undefined,
): Promise<CommandOutput> {
  const health = await probeHealth(server, token);
  const serverOperationNames = health.healthy
    ? await fetchServerOperationNames(server, token)
    : undefined;
  const additionalOperations = additionalServerOperations(serverOperationNames);
  const exitCode = health.healthy ? 0 : health.connectionError ? 2 : 1;

  if (command.json) {
    return {
      stdout: prettyJson({
        server: server.toString(),
        healthy: health.healthy,
        detail: health.detail,
        cliOperationCount: CATALOG_OPERATION_NAMES.length,
        serverOperationCount: serverOperationNames?.length ?? null,
        additionalOperations,
      }),
      exitCode,
    };
  }

  return {
    stdout: formatServerInfoLines(server, health, serverOperationNames, additionalOperations).join(
      '\n',
    ),
    exitCode,
  };
}
