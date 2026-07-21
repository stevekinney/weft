/**
 * Shared Weft server connection resolution for the HTTP client and CLI commands.
 *
 * A single resolver backs every entry point so `WEFT_ADDR`, `WEFT_TOKEN`,
 * `~/.weft/config` profiles, the local run lockfile, and the development default
 * are interpreted identically whether you construct an {@link HttpClient} or run
 * `weft api`/`weft codegen`.
 *
 * Resolution order for the server address is explicit option, then `WEFT_ADDR`,
 * then the selected profile's `server`, then the run lockfile written by
 * `weft serve` (CLI only — see `includeRunLockfile`), then
 * `http://localhost:7233`. Token resolution prefers the explicit option, then
 * `WEFT_TOKEN`, then the profile token (with `env:` and `tokenEnv` indirection).
 * A profile token is only applied when neither an explicit `server` option nor
 * `WEFT_ADDR` redirected the request to a different destination.
 *
 * This module is imported from `@lostgradient/weft/client` (browser-reachable),
 * so it must stay statically free of `node:*` and Bun-only imports. Environment
 * variables go through {@link readEnvironmentVariable}; `~/.weft/config` and the
 * run lockfile are read through {@link tryLoadNodeBuiltin}, which resolves
 * `node:fs`/`node:fs/promises` via `process.getBuiltinModule` instead of a
 * static import. Both return `undefined` outside Bun/Node, so a browser caller
 * that supplies explicit `server`/`token` never touches either.
 *
 * @module connection
 */

import { readEnvironmentVariable, tryLoadNodeBuiltin } from './runtime/portable.ts';

/**
 * Inputs accepted by {@link resolveConnection}.
 *
 * @example
 * ```ts
 * import { resolveConnection, type ConnectionOptions } from '@lostgradient/weft';
 *
 * const options: ConnectionOptions = {
 *   server: 'https://weft.example.com',
 *   token: 'secret-token',
 * };
 *
 * const connection = resolveConnection(options);
 * console.log(connection.server.toString());
 * ```
 */
export type ConnectionOptions = {
  readonly server?: string;
  readonly token?: string;
  readonly profile?: string;
  /**
   * Consult the local run lockfile written by `weft serve` as a fallback server
   * address. Defaults to `true` for CLI developer convenience; library clients
   * pass `false` so resolution stays explicit-options/env/profile/default.
   */
  readonly includeRunLockfile?: boolean;
};

/**
 * Resolved Weft server connection settings.
 *
 * @example
 * ```ts
 * import { resolveConnection, type ResolvedConnection } from '@lostgradient/weft';
 *
 * const connection: ResolvedConnection = resolveConnection({
 *   server: 'https://weft.example.com',
 *   token: 'secret-token',
 * });
 *
 * console.log(connection.token);
 * ```
 */
export type ResolvedConnection = {
  readonly server: URL;
  readonly token?: string;
};

/**
 * Default local Weft server address used when nothing else resolves.
 *
 * @example
 * ```ts
 * import { DEFAULT_WEFT_ADDRESS } from '@lostgradient/weft';
 *
 * console.log(DEFAULT_WEFT_ADDRESS); // "http://localhost:7233"
 * ```
 */
export const DEFAULT_WEFT_ADDRESS = 'http://localhost:7233';

/**
 * Raised when connection resolution fails. Two cases surface as this error:
 * a present `~/.weft/config` file that cannot be parsed (a missing file is not
 * an error), and a resolved server value that is not a valid URL — regardless
 * of where it came from (`--server`/explicit option, `WEFT_ADDR`, the profile
 * `server` field, or the run lockfile). Both are surfaced rather than silently
 * connecting to the wrong server; the message carries the offending value (the
 * invalid URL string, or the config path for a parse failure).
 *
 * @example
 * ```ts
 * import { ConnectionConfigurationError, resolveConnection } from '@lostgradient/weft';
 *
 * try {
 *   resolveConnection();
 * } catch (error) {
 *   if (error instanceof ConnectionConfigurationError) {
 *     console.error(error.message);
 *   }
 * }
 * ```
 */
export class ConnectionConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConnectionConfigurationError';
  }
}

type WeftProfile = {
  readonly server?: string;
  readonly token?: string;
  readonly tokenEnv?: string;
};

type WeftConfiguration = {
  readonly defaultProfile?: string;
  readonly profiles?: Record<string, WeftProfile>;
};

type WeftRunLockfile = {
  readonly server?: string;
  readonly url?: string;
};

/**
 * Resolve Weft server connection settings from explicit options, environment
 * variables, `~/.weft/config`, the local run lockfile (when
 * `includeRunLockfile` is not `false`), and the development default.
 *
 * Resolution is synchronous so it can run inside the {@link HttpClient}
 * constructor and CLI command handlers alike.
 *
 * @example
 * ```ts
 * import { resolveConnection } from '@lostgradient/weft';
 *
 * const connection = resolveConnection({ server: 'https://weft.example.com' });
 * console.log(connection.server.toString()); // "https://weft.example.com/"
 * ```
 */
export function resolveConnection(options: ConnectionOptions = {}): ResolvedConnection {
  const context = resolveConnectionContext(options);
  const server = resolveServerString(context);
  const fallbackProfile = profileForToken(context, server);
  const token = resolveToken(
    options.token ?? readEnvironmentVariable('WEFT_TOKEN'),
    fallbackProfile,
  );

  return {
    server: parseServerUrl(server),
    ...(token === undefined ? {} : { token }),
  };
}

/**
 * Parse the resolved server string into a {@link URL}. A malformed value is a
 * user-caused configuration error regardless of which source it came from
 * (explicit option, `WEFT_ADDR`, profile `server`, or the run lockfile), so it
 * surfaces as a {@link ConnectionConfigurationError} carrying the offending
 * string rather than a bare `TypeError`. Callers that shape user diagnostics
 * (for example `weft codegen`) can then report the actual invalid value.
 */
function parseServerUrl(server: string): URL {
  try {
    return new URL(server);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new ConnectionConfigurationError(`Invalid server URL '${server}': ${reason}`);
  }
}

/**
 * Decide whether the selected profile's token may back the resolved
 * connection. A profile token is bound to the profile's own server, so it is
 * only applied when the request is actually heading there.
 *
 * When no explicit `server` option or `WEFT_ADDR` overrides the address, the
 * profile is its own destination, so its token applies. When an override is
 * present, the token applies only if the override points at the same
 * destination as the profile's `server`; an override to a different host (or a
 * profile with no `server` to compare against) drops the token so credentials
 * never leak to a server the profile did not name.
 */
function profileForToken(
  context: ConnectionContext,
  resolvedServer: string,
): WeftProfile | undefined {
  if (context.profile === undefined) return undefined;
  const serverIsOverridden =
    context.options.server !== undefined || readEnvironmentVariable('WEFT_ADDR') !== undefined;
  if (!serverIsOverridden) return context.profile;
  const profileServer = context.profile.server;
  if (profileServer === undefined) return undefined;
  return sameDestination(resolvedServer, profileServer) ? context.profile : undefined;
}

/**
 * Compare two server strings by destination (origin plus normalized path),
 * ignoring trailing slashes, query strings, and fragments. Malformed URLs fall
 * back to an exact string comparison so a parse failure never silently treats
 * two distinct destinations as equal.
 */
function sameDestination(a: string, b: string): boolean {
  let left: URL;
  let right: URL;
  try {
    left = new URL(a);
    right = new URL(b);
  } catch {
    return a === b;
  }
  return (
    left.origin === right.origin &&
    left.pathname.replace(/\/+$/, '') === right.pathname.replace(/\/+$/, '')
  );
}

type ConnectionContext = {
  readonly options: ConnectionOptions;
  readonly profile?: WeftProfile;
  readonly runLockfile?: WeftRunLockfile;
};

function resolveConnectionContext(options: ConnectionOptions): ConnectionContext {
  const configuration = readWeftConfiguration();
  const profileName =
    options.profile ?? readEnvironmentVariable('WEFT_PROFILE') ?? configuration.defaultProfile;
  const profile = profileName === undefined ? undefined : configuration.profiles?.[profileName];
  const runLockfile = options.includeRunLockfile === false ? undefined : readRunLockfile();
  return {
    options,
    ...(profile === undefined ? {} : { profile }),
    ...(runLockfile === undefined ? {} : { runLockfile }),
  };
}

function resolveServerString(context: ConnectionContext): string {
  return (
    context.options.server ??
    readEnvironmentVariable('WEFT_ADDR') ??
    context.profile?.server ??
    context.runLockfile?.server ??
    context.runLockfile?.url ??
    DEFAULT_WEFT_ADDRESS
  );
}

/**
 * `~/.weft/config`, the run lockfile, and `writeRunLockfile`/`removeRunLockfile`
 * are a Bun/Node CLI-and-server convenience with no browser equivalent.
 * {@link tryLoadNodeBuiltin} resolves `node:fs`/`node:fs/promises` via
 * `process.getBuiltinModule` rather than a static import, so calling these in
 * a runtime without it (the browser) degrades to "no config/lockfile found"
 * instead of throwing.
 */
function loadFsModule(): typeof import('node:fs') | undefined {
  return tryLoadNodeBuiltin<typeof import('node:fs')>('node:fs');
}

function loadFsPromisesModule(): typeof import('node:fs/promises') | undefined {
  return tryLoadNodeBuiltin<typeof import('node:fs/promises')>('node:fs/promises');
}

/** Record the address of a running server so later CLI commands can find it. */
export async function writeRunLockfile(server: string): Promise<void> {
  const fsPromises = loadFsPromisesModule();
  if (fsPromises === undefined) {
    throw new Error(
      'writeRunLockfile requires Bun or Node 22.5+ (process.getBuiltinModule); ' +
        'not available in this runtime.',
    );
  }
  await fsPromises.mkdir(weftHome(), { recursive: true });
  const contents = `${JSON.stringify({ server }, null, 2)}\n`;
  if (typeof Bun !== 'undefined') {
    await Bun.write(runLockfilePath(), contents);
    return;
  }
  await fsPromises.writeFile(runLockfilePath(), contents, 'utf8');
}

/** Remove the run lockfile when the recorded server shuts down. */
export async function removeRunLockfile(server: string): Promise<void> {
  const lockfile = readRunLockfile();
  if (lockfile === undefined) return;
  if ((lockfile.server ?? lockfile.url) !== server) return;
  const fsPromises = loadFsPromisesModule();
  if (fsPromises === undefined) return;
  await fsPromises.rm(runLockfilePath(), { force: true });
}

function readWeftConfiguration(): WeftConfiguration {
  // `Bun.TOML` is Bun-only, so config-file resolution additionally requires
  // Bun (not just any runtime `node:fs` happens to be reachable from).
  if (typeof Bun === 'undefined') return {};
  const fs = loadFsModule();
  if (fs === undefined) return {};
  const path = configurationPath();
  if (!fs.existsSync(path)) return {};
  let parsed: unknown;
  try {
    parsed = Bun.TOML.parse(fs.readFileSync(path, 'utf8'));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ConnectionConfigurationError(
      `Failed to read connection configuration at ${path}: ${message}`,
    );
  }
  return normalizeConfiguration(parsed);
}

function readRunLockfile(): WeftRunLockfile | undefined {
  const fs = loadFsModule();
  if (fs === undefined) return undefined;
  const path = runLockfilePath();
  if (!fs.existsSync(path)) return undefined;
  const text = fs.readFileSync(path, 'utf8').trim();
  if (text === '') return undefined;
  try {
    return normalizeRunLockfile(JSON.parse(text) as unknown);
  } catch {
    return undefined;
  }
}

function normalizeConfiguration(value: unknown): WeftConfiguration {
  if (!isRecord(value)) return {};
  const profiles = normalizeProfiles(value['profiles']);
  const defaultProfile = stringValue(value['defaultProfile'] ?? value['default_profile']);
  return {
    ...(defaultProfile === undefined ? {} : { defaultProfile }),
    profiles,
  };
}

function normalizeProfiles(value: unknown): Record<string, WeftProfile> {
  const profiles: Record<string, WeftProfile> = {};
  if (!isRecord(value)) return profiles;
  for (const [name, profile] of Object.entries(value)) {
    const normalized = normalizeProfile(profile);
    if (normalized !== undefined) profiles[name] = normalized;
  }
  return profiles;
}

function normalizeProfile(value: unknown): WeftProfile | undefined {
  if (!isRecord(value)) return undefined;
  const server = stringValue(value['server']);
  const token = stringValue(value['token']);
  const tokenEnv = stringValue(value['tokenEnv'] ?? value['token_env']);
  return {
    ...(server === undefined ? {} : { server }),
    ...(token === undefined ? {} : { token }),
    ...(tokenEnv === undefined ? {} : { tokenEnv }),
  };
}

function normalizeRunLockfile(value: unknown): WeftRunLockfile | undefined {
  if (!isRecord(value)) return undefined;
  const server = stringValue(value['server']);
  const url = stringValue(value['url']);
  if (server === undefined && url === undefined) return undefined;
  return {
    ...(server === undefined ? {} : { server }),
    ...(url === undefined ? {} : { url }),
  };
}

function resolveToken(
  token: string | undefined,
  profile: WeftProfile | undefined,
): string | undefined {
  const directToken = token ?? profile?.token;
  if (directToken?.startsWith('env:')) {
    return readEnvironmentVariable(directToken.slice('env:'.length));
  }
  if (directToken !== undefined) return directToken;
  if (profile?.tokenEnv !== undefined) return readEnvironmentVariable(profile.tokenEnv);
  return undefined;
}

function configurationPath(): string {
  return `${weftHome()}/config`;
}

function runLockfilePath(): string {
  return `${weftHome()}/run`;
}

function weftHome(): string {
  return readEnvironmentVariable('WEFT_HOME') ?? `${readEnvironmentVariable('HOME') ?? '.'}/.weft`;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
