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

import { resolveCliConnection } from './connection.ts';
import { CATALOG_OPERATION_NAMES } from './generated/operation-client.generated.ts';
import { prettyJson } from './output.ts';
import type { CommandOutput, ServerCommand } from './types.ts';

const HEALTH_POLL_INTERVAL_MS = 250;

/** Execute `weft server health` or `weft server info`. */
export async function executeServer(command: ServerCommand): Promise<CommandOutput> {
  const serverUrl = await resolveServerUrl(command);
  if (command.action === 'health') return executeServerHealth(command, serverUrl);
  return executeServerInfo(command, serverUrl);
}

async function resolveServerUrl(command: ServerCommand): Promise<URL> {
  const connection = await resolveCliConnection({
    ...(command.server === undefined ? {} : { server: command.server }),
    ...(command.token === undefined ? {} : { token: command.token }),
    ...(command.profile === undefined ? {} : { profile: command.profile }),
  });
  return connection.server;
}

function healthEndpoint(server: URL): URL {
  const endpoint = new URL(server.toString());
  const basePath = endpoint.pathname.endsWith('/') ? endpoint.pathname : `${endpoint.pathname}/`;
  endpoint.pathname = `${basePath}v1/health`.replaceAll(/\/+/g, '/');
  endpoint.search = '';
  endpoint.hash = '';
  return endpoint;
}

function metaEndpoint(server: URL, path: string): URL {
  const endpoint = new URL(server.toString());
  const basePath = endpoint.pathname.endsWith('/') ? endpoint.pathname : `${endpoint.pathname}/`;
  endpoint.pathname = `${basePath}${path}`.replaceAll(/\/+/g, '/');
  endpoint.search = '';
  endpoint.hash = '';
  return endpoint;
}

async function probeHealth(server: URL): Promise<{ healthy: boolean; detail: string }> {
  try {
    const response = await fetch(healthEndpoint(server), { method: 'GET' });
    if (!response.ok) {
      return { healthy: false, detail: `server returned status ${response.status}` };
    }
    return { healthy: true, detail: 'ok' };
  } catch (error) {
    return { healthy: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

async function executeServerHealth(command: ServerCommand, server: URL): Promise<CommandOutput> {
  const result = command.wait
    ? await waitForHealth(server, command.waitTimeoutMs)
    : await probeHealth(server);

  if (command.json) {
    return {
      stdout: prettyJson({
        server: server.toString(),
        healthy: result.healthy,
        detail: result.detail,
      }),
      exitCode: result.healthy ? 0 : 1,
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
    exitCode: 1,
  };
}

async function waitForHealth(
  server: URL,
  timeoutMs: number,
): Promise<{ healthy: boolean; detail: string }> {
  const deadline = Date.now() + timeoutMs;
  let last = await probeHealth(server);
  while (!last.healthy && Date.now() < deadline) {
    await Bun.sleep(HEALTH_POLL_INTERVAL_MS);
    last = await probeHealth(server);
  }
  return last;
}

type OpenRpcDocument = { readonly methods?: ReadonlyArray<{ readonly name?: unknown }> };

function isOpenRpcDocument(value: unknown): value is OpenRpcDocument {
  return typeof value === 'object' && value !== null;
}

async function fetchServerOperationNames(server: URL): Promise<ReadonlyArray<string> | undefined> {
  try {
    const response = await fetch(metaEndpoint(server, 'openrpc.json'), { method: 'GET' });
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

async function executeServerInfo(command: ServerCommand, server: URL): Promise<CommandOutput> {
  const health = await probeHealth(server);
  const serverOperationNames = health.healthy ? await fetchServerOperationNames(server) : undefined;
  const additionalOperations = additionalServerOperations(serverOperationNames);
  const exitCode = health.healthy ? 0 : 1;

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
