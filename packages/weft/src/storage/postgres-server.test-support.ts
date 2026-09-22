import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readEnvironmentVariable } from '../runtime/environment-configuration.ts';

/** A live PostgreSQL the storage suites can talk to, however it was obtained. */
export type PostgresTestDatabase = {
  host: string;
  port: number;
  url: string;
  [Symbol.asyncDispose](): Promise<void>;
};

/** Where a live database comes from on this machine. */
export type PostgresTestDatabaseSource =
  | { readonly kind: 'supplied'; readonly url: string }
  | { readonly kind: 'cluster'; readonly initialize: string; readonly control: string };

/** The `initdb` and `pg_ctl` a disposable cluster needs, each `null` when absent from PATH. */
export function postgresClientBinaries(): {
  readonly initialize: string | null;
  readonly control: string | null;
} {
  return { initialize: Bun.which('initdb'), control: Bun.which('pg_ctl') };
}

/**
 * Decide where the live suites get a database, from facts rather than from ambient state.
 *
 * A supplied URL wins over the client binaries: a runner that hands us a URL is running
 * the server itself, and spawning a second cluster beside it would test the same wire
 * protocol against a database nobody asked for. `null` is the honest third answer — not
 * an error — and the suites that call {@link createPostgresTestServer} gate on it.
 */
export function selectPostgresTestDatabase(
  suppliedUrl: string | undefined,
  binaries: { readonly initialize: string | null; readonly control: string | null },
): PostgresTestDatabaseSource | null {
  if (suppliedUrl !== undefined && suppliedUrl !== '')
    return { kind: 'supplied', url: suppliedUrl };
  const { initialize, control } = binaries;
  if (initialize !== null && control !== null) return { kind: 'cluster', initialize, control };
  return null;
}

/**
 * The database this process can reach, or `null` when it can reach none.
 *
 * Three environments run these files and each needs a different answer, so the decision
 * lives here and the calling suites carry it as `describe.skipIf(!postgresTestDatabase)`:
 *
 * - A CI job that runs PostgreSQL as a service container sets `WEFT_TEST_POSTGRES_URL`
 *   and has no client binaries on PATH. Connect to the URL and run: this is the only
 *   place the real `pg` wire protocol is exercised, so skipping where a database exists
 *   would publish an untested adapter.
 * - A CI job with neither — the hermetic unit sweep — gets `null` and skips. Throwing
 *   there would fail a job that has no database and never asked for one.
 * - A developer machine has the binaries and usually no URL, so it still spawns the
 *   disposable cluster below.
 *
 * Read through the registered runtime boundary rather than off `Bun.env`, the same way
 * `testing/browser-smoke-gate.test-support.ts` reads its own opt-in switch: a test-only
 * variable does not belong in a production configuration schema, and
 * `readEnvironmentVariable` is that boundary's sanctioned single-name read. The value is
 * resolved once at import, which is what `describe.skipIf` needs — a suite is skipped
 * when it is registered, and nothing inside `beforeAll` can skip it after the fact.
 */
export const postgresTestDatabase: PostgresTestDatabaseSource | null = selectPostgresTestDatabase(
  readEnvironmentVariable('WEFT_TEST_POSTGRES_URL'),
  postgresClientBinaries(),
);

/**
 * Open the live database named by `source`: connect to a supplied URL, or start a
 * disposable real PostgreSQL cluster for wire-protocol and contention tests.
 *
 * Throwing when `source` is `null` is a misuse guard, not an environment behaviour: a
 * caller reaches it only by skipping the `postgresTestDatabase` gate, which is the bug
 * the message names.
 */
export async function createPostgresTestServer(
  source: PostgresTestDatabaseSource | null = postgresTestDatabase,
): Promise<PostgresTestDatabase> {
  if (source === null) {
    throw new Error(
      'No PostgreSQL is available: set WEFT_TEST_POSTGRES_URL, or put initdb and pg_ctl on PATH. Gate the suite on `postgresTestDatabase` so it skips instead of reaching here.',
    );
  }
  if (source.kind === 'supplied') return suppliedPostgresDatabase(source.url);
  return startDisposablePostgres(source.initialize, source.control);
}

/**
 * Describe a server someone else runs. Disposal is deliberately a no-op: the runner that
 * supplied the URL owns the server's lifetime, and both live suites dispose what they
 * open, so stopping it here would pull the database out from under the next file.
 */
function suppliedPostgresDatabase(url: string): PostgresTestDatabase {
  const { hostname, port } = new URL(url);
  return {
    host: hostname,
    port: port === '' ? 5432 : Number(port),
    url,
    [Symbol.asyncDispose]: () => Promise.resolve(),
  };
}

async function startDisposablePostgres(
  initialize: string,
  control: string,
): Promise<PostgresTestDatabase> {
  const directory = await mkdtemp(join(tmpdir(), 'corvidae-postgres-'));
  const data = join(directory, 'data');
  const log = join(directory, 'postgres.log');
  let started = false;
  try {
    await runPostgresCommand([
      initialize,
      '-D',
      data,
      '-A',
      'trust',
      '-U',
      'corvidae_test',
      '--no-locale',
      '-E',
      'UTF8',
    ]);
    const port = await availablePort();
    await runPostgresCommand([
      control,
      '-D',
      data,
      '-l',
      log,
      '-o',
      `-h 127.0.0.1 -p ${port} -k ${directory}`,
      '-w',
      'start',
    ]);
    started = true;
    return {
      host: '127.0.0.1',
      port,
      url: `postgresql://corvidae_test@127.0.0.1:${port}/postgres`,
      async [Symbol.asyncDispose]() {
        await runPostgresCommand([control, '-D', data, '-m', 'fast', '-w', 'stop']);
        await rm(directory, { recursive: true });
      },
    };
  } catch (error) {
    if (started) await runPostgresCommand([control, '-D', data, '-m', 'fast', '-w', 'stop']);
    const detail = await readFile(log, 'utf8').catch(
      () => 'PostgreSQL did not create its server log.',
    );
    await rm(directory, { recursive: true });
    throw new Error(`Could not start disposable PostgreSQL: ${detail}`, { cause: error });
  }
}

/**
 * Build the child environment for `initdb` and `pg_ctl`.
 *
 * PostgreSQL 18 aborts startup with `postmaster became multithreaded during startup`
 * whenever the postmaster gains a thread before it forks, and on macOS the locale
 * lookup does exactly that when `LC_ALL` is unset. Pinning `LC_ALL` to `C` keeps the
 * postmaster single-threaded and matches the `initdb --no-locale` cluster this harness
 * already creates.
 *
 * `Bun.spawn` replaces the child environment rather than merging it, so the ambient
 * environment is forwarded: `initdb` and `pg_ctl` locate the `postgres` binary through
 * `PATH`, and `HOME` and `TMPDIR` carry the rest of their per-user state. Every `PG*`
 * variable is dropped instead: the cluster names its data directory, host, port, socket
 * directory, and superuser as explicit flags, so an ambient `PGDATA`, `PGHOST`,
 * `PGPORT`, `PGUSER`, or `PGPASSWORD` could only redirect the disposable cluster or the
 * `pg_ctl -w` readiness probe at a developer's own server.
 */
export function postgresCommandEnvironment(
  environment: Readonly<Record<string, string | undefined>> = Bun.env,
): Record<string, string | undefined> {
  const childEnvironment: Record<string, string | undefined> = { ...environment, LC_ALL: 'C' };
  for (const name of Object.keys(childEnvironment)) {
    if (name.startsWith('PG')) delete childEnvironment[name];
  }
  return childEnvironment;
}

async function runPostgresCommand(command: string[]): Promise<void> {
  const child = Bun.spawn(command, {
    stdout: 'pipe',
    stderr: 'pipe',
    env: postgresCommandEnvironment(),
  });
  const [status, output, error] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (status !== 0) throw new Error(`${command[0]} exited ${status}: ${output}\n${error}`);
}

async function availablePort(): Promise<number> {
  const listener = createServer();
  await new Promise<void>((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', resolve);
  });
  const address = listener.address();
  await new Promise<void>((resolve, reject) => {
    listener.close((error) => (error ? reject(error) : resolve()));
  });
  if (address === null || typeof address === 'string') throw new Error('TCP listener has no port.');
  return address.port;
}
