import { describe, expect, it } from 'bun:test';

import {
  createPostgresTestServer,
  postgresClientBinaries,
  postgresCommandEnvironment,
  selectPostgresTestDatabase,
} from './postgres-server.test-support.ts';

// This file's subject is the disposable cluster, so it asks whether one could be
// spawned while ignoring any supplied URL: a developer with `WEFT_TEST_POSTGRES_URL`
// exported should still exercise the path the test is named after. A runner with
// neither the binaries nor a URL skips, which is the behaviour weft's hermetic `test`
// job depends on.
const clusterSource = selectPostgresTestDatabase(undefined, postgresClientBinaries());

const ambient = {
  PATH: '/usr/local/bin:/usr/bin',
  HOME: '/Users/corvidae',
  TMPDIR: '/var/folders/corvidae/',
  PGDATA: '/Users/corvidae/Library/Application Support/Postgres/data',
  PGHOST: 'production.example.com',
  PGPORT: '5432',
  PGUSER: 'owner',
  PGPASSWORD: 'not-a-secret-in-this-fixture',
} as const;

describe('disposable PostgreSQL harness environment', () => {
  it('pins LC_ALL so the postmaster stays single-threaded on macOS', () => {
    expect(postgresCommandEnvironment({ PATH: ambient.PATH })['LC_ALL']).toBe('C');
  });

  it('overrides an ambient locale rather than inheriting it', () => {
    expect(postgresCommandEnvironment({ LC_ALL: 'en_US.UTF-8', LANG: 'en_US.UTF-8' })).toEqual({
      LC_ALL: 'C',
      LANG: 'en_US.UTF-8',
    });
  });

  it('forwards the ambient variables initdb and pg_ctl need', () => {
    const environment = postgresCommandEnvironment(ambient);

    expect(environment['PATH']).toBe(ambient.PATH);
    expect(environment['HOME']).toBe(ambient.HOME);
    expect(environment['TMPDIR']).toBe(ambient.TMPDIR);
  });

  it('drops every ambient PostgreSQL variable so the cluster stays self-contained', () => {
    const environment = postgresCommandEnvironment(ambient);

    for (const name of ['PGDATA', 'PGHOST', 'PGPORT', 'PGUSER', 'PGPASSWORD']) {
      expect(Object.hasOwn(environment, name), name).toBe(false);
    }
  });

  it('leaves the caller-supplied environment untouched', () => {
    const supplied = { PGHOST: 'production.example.com', LANG: 'en_US.UTF-8' };

    postgresCommandEnvironment(supplied);

    expect(supplied).toEqual({ PGHOST: 'production.example.com', LANG: 'en_US.UTF-8' });
  });
});

describe('choosing where the live suites get a database', () => {
  const binaries = { initialize: '/usr/local/bin/initdb', control: '/usr/local/bin/pg_ctl' };
  const none = { initialize: null, control: null };

  it('connects to a supplied URL rather than spawning beside the server that runs it', () => {
    // A runner that hands us a URL is running PostgreSQL itself, so a second cluster
    // would test the same wire protocol against a database nobody asked for.
    expect(selectPostgresTestDatabase('postgresql://ci@127.0.0.1:5432/weft', binaries)).toEqual({
      kind: 'supplied',
      url: 'postgresql://ci@127.0.0.1:5432/weft',
    });
  });

  it('spawns a disposable cluster when only the client binaries are present', () => {
    expect(selectPostgresTestDatabase(undefined, binaries)).toEqual({
      kind: 'cluster',
      initialize: binaries.initialize,
      control: binaries.control,
    });
  });

  it('reports no database, rather than throwing, when a runner has neither', () => {
    // Weft's hermetic `test` job: no URL, no binaries. Skipping is the only correct
    // behaviour there, and a throw would fail a job that never asked for a database.
    expect(selectPostgresTestDatabase(undefined, none)).toBeNull();
    expect(selectPostgresTestDatabase('', none)).toBeNull();
  });

  it('treats a half-installed client as no cluster at all', () => {
    expect(
      selectPostgresTestDatabase(undefined, { ...none, initialize: '/bin/initdb' }),
    ).toBeNull();
    expect(selectPostgresTestDatabase(undefined, { ...none, control: '/bin/pg_ctl' })).toBeNull();
  });

  it('names the gate when asked for a database that cannot be obtained', async () => {
    await expect(createPostgresTestServer(null)).rejects.toThrow('postgresTestDatabase');
  });

  it('reads host and port off a supplied URL and never stops that server', async () => {
    // The runner owns the server's lifetime, so disposal is a no-op — stopping it here
    // would pull the database out from under the next file in the sweep.
    const supplied = await createPostgresTestServer({
      kind: 'supplied',
      url: 'postgresql://ci@db.internal:6543/weft',
    });

    expect(supplied.host).toBe('db.internal');
    expect(supplied.port).toBe(6543);
    await supplied[Symbol.asyncDispose]();
  });

  it('defaults a supplied URL without a port to 5432', async () => {
    const supplied = await createPostgresTestServer({
      kind: 'supplied',
      url: 'postgresql://ci@db.internal/weft',
    });

    expect(supplied.port).toBe(5432);
    await supplied[Symbol.asyncDispose]();
  });
});

describe('the disposable cluster failure path', () => {
  it('cleans up the working directory and reports the server log detail when initdb fails', async () => {
    // `/usr/bin/false` is a real, always-present executable that exits 1
    // immediately — no real PostgreSQL install required to exercise the
    // startDisposablePostgres catch block deterministically.
    await expect(
      createPostgresTestServer({
        kind: 'cluster',
        initialize: '/usr/bin/false',
        control: '/usr/bin/false',
      }),
    ).rejects.toThrow('Could not start disposable PostgreSQL:');
  });
});

describe.skipIf(clusterSource === null)('the disposable PostgreSQL cluster', () => {
  it('starts a cluster that accepts connections', async () => {
    await using server = await createPostgresTestServer(clusterSource);

    expect(server.host).toBe('127.0.0.1');
    expect(server.port).toBeGreaterThan(0);
    expect(server.url).toBe(`postgresql://corvidae_test@127.0.0.1:${server.port}/postgres`);

    const socket = await Bun.connect({
      hostname: '127.0.0.1',
      port: server.port,
      socket: { data: () => {} },
    });
    socket.end();
  });
});
