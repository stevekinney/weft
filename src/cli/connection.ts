import { mkdir, rm } from 'node:fs/promises';

export type CliConnectionOptions = {
  readonly server?: string;
  readonly token?: string;
  readonly profile?: string;
};

export type ResolvedCliConnection = {
  readonly server: URL;
  readonly token?: string;
};

type WeftProfile = {
  readonly server?: string;
  readonly token?: string;
  readonly tokenEnv?: string;
};

type WeftConfiguration = {
  readonly defaultProfile?: string;
  readonly profile?: string;
  readonly profiles?: Record<string, WeftProfile>;
};

type WeftRunLockfile = {
  readonly server?: string;
  readonly url?: string;
};

export async function resolveCliConnection(
  options: CliConnectionOptions,
): Promise<ResolvedCliConnection> {
  const context = await resolveConnectionContext(options);
  const server = resolveServerString(context);
  const token = resolveToken(
    options.token ?? Bun.env['WEFT_TOKEN'] ?? context.profile?.token,
    context.profile,
  );

  return {
    server: new URL(server),
    ...(token === undefined ? {} : { token }),
  };
}

type ConnectionContext = {
  readonly options: CliConnectionOptions;
  readonly profile?: WeftProfile;
  readonly runLockfile?: WeftRunLockfile;
};

async function resolveConnectionContext(options: CliConnectionOptions): Promise<ConnectionContext> {
  const configuration = await readWeftConfiguration();
  const profileName = options.profile ?? Bun.env['WEFT_PROFILE'] ?? configuration.defaultProfile;
  const profile = profileName === undefined ? undefined : configuration.profiles?.[profileName];
  const runLockfile = await readRunLockfile();
  return {
    options,
    ...(profile === undefined ? {} : { profile }),
    ...(runLockfile === undefined ? {} : { runLockfile }),
  };
}

function resolveServerString(context: ConnectionContext): string {
  return (
    context.options.server ??
    Bun.env['WEFT_ADDR'] ??
    context.profile?.server ??
    context.runLockfile?.server ??
    context.runLockfile?.url ??
    'http://localhost:7233'
  );
}

export async function writeRunLockfile(server: string): Promise<void> {
  const path = runLockfilePath();
  await mkdir(weftHome(), { recursive: true });
  await Bun.write(path, `${JSON.stringify({ server }, null, 2)}\n`);
}

export async function removeRunLockfile(server: string): Promise<void> {
  const path = runLockfilePath();
  const lockfile = await readRunLockfile();
  if (lockfile === undefined) return;
  if ((lockfile.server ?? lockfile.url) !== server) return;
  await rm(path, { force: true });
}

async function readWeftConfiguration(): Promise<WeftConfiguration> {
  const file = Bun.file(configurationPath());
  if (!(await file.exists())) return {};
  const parsed = Bun.TOML.parse(await file.text()) as unknown;
  return normalizeConfiguration(parsed);
}

async function readRunLockfile(): Promise<WeftRunLockfile | undefined> {
  const file = Bun.file(runLockfilePath());
  if (!(await file.exists())) return undefined;
  const fileText = await file.text();
  const text = fileText.trim();
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
  if (directToken?.startsWith('env:')) return Bun.env[directToken.slice('env:'.length)];
  if (directToken !== undefined) return directToken;
  if (profile?.tokenEnv !== undefined) return Bun.env[profile.tokenEnv];
  return undefined;
}

function configurationPath(): string {
  return `${weftHome()}/config`;
}

function runLockfilePath(): string {
  return `${weftHome()}/run`;
}

function weftHome(): string {
  return Bun.env['WEFT_HOME'] ?? `${Bun.env['HOME'] ?? '.'}/.weft`;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
