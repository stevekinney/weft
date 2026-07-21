import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ConnectionConfigurationError,
  DEFAULT_WEFT_ADDRESS,
  removeRunLockfile,
  resolveConnection,
  writeRunLockfile,
} from './connection.ts';
import { setPortableRuntimeTestOverridesForTesting } from './runtime/portable.ts';

const created: string[] = [];

function makeHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'weft-connection-'));
  created.push(dir);
  return dir;
}

function writeConfig(home: string, contents: string): void {
  writeFileSync(join(home, 'config'), contents);
}

function writeLockfile(home: string, server: string): void {
  writeFileSync(join(home, 'run'), `${JSON.stringify({ server })}\n`);
}

type EnvSnapshot = Record<string, string | undefined>;

function snapshotEnv(...keys: string[]): EnvSnapshot {
  const snapshot: EnvSnapshot = {};
  for (const key of keys) snapshot[key] = Bun.env[key];
  return snapshot;
}

function restoreEnv(snapshot: EnvSnapshot): void {
  for (const [key, value] of Object.entries(snapshot)) {
    if (value === undefined) delete Bun.env[key];
    else Bun.env[key] = value;
  }
}

afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('resolveConnection', () => {
  it('falls back to the local development default with no inputs', () => {
    const snapshot = snapshotEnv('WEFT_ADDR', 'WEFT_TOKEN', 'WEFT_PROFILE', 'WEFT_HOME');
    const home = makeHome();
    Bun.env['WEFT_HOME'] = home;
    delete Bun.env['WEFT_ADDR'];
    delete Bun.env['WEFT_TOKEN'];
    delete Bun.env['WEFT_PROFILE'];
    try {
      const connection = resolveConnection();
      expect(connection.server.toString()).toBe(`${DEFAULT_WEFT_ADDRESS}/`);
      expect(connection.token).toBeUndefined();
    } finally {
      restoreEnv(snapshot);
    }
  });

  it('prefers explicit options over the environment', () => {
    const snapshot = snapshotEnv('WEFT_ADDR', 'WEFT_TOKEN', 'WEFT_HOME');
    const home = makeHome();
    Bun.env['WEFT_HOME'] = home;
    Bun.env['WEFT_ADDR'] = 'http://environment.test';
    Bun.env['WEFT_TOKEN'] = 'environment-token';
    try {
      const connection = resolveConnection({
        server: 'http://explicit.test',
        token: 'explicit-token',
      });
      expect(connection.server.toString()).toBe('http://explicit.test/');
      expect(connection.token).toBe('explicit-token');
    } finally {
      restoreEnv(snapshot);
    }
  });

  it('reads WEFT_ADDR and WEFT_TOKEN when no explicit options are given', () => {
    const snapshot = snapshotEnv('WEFT_ADDR', 'WEFT_TOKEN', 'WEFT_HOME');
    const home = makeHome();
    Bun.env['WEFT_HOME'] = home;
    Bun.env['WEFT_ADDR'] = 'http://environment.test';
    Bun.env['WEFT_TOKEN'] = 'environment-token';
    try {
      const connection = resolveConnection();
      expect(connection.server.toString()).toBe('http://environment.test/');
      expect(connection.token).toBe('environment-token');
    } finally {
      restoreEnv(snapshot);
    }
  });

  it('reads a named profile with env-prefixed token indirection', () => {
    const snapshot = snapshotEnv(
      'WEFT_ADDR',
      'WEFT_TOKEN',
      'WEFT_PROFILE',
      'WEFT_HOME',
      'CI_TOKEN',
    );
    const home = makeHome();
    Bun.env['WEFT_HOME'] = home;
    delete Bun.env['WEFT_ADDR'];
    delete Bun.env['WEFT_TOKEN'];
    delete Bun.env['WEFT_PROFILE'];
    Bun.env['CI_TOKEN'] = 'ci-secret';
    writeConfig(
      home,
      [
        'default_profile = "ci"',
        '',
        '[profiles.ci]',
        'server = "http://profile.test:9000"',
        'token = "env:CI_TOKEN"',
      ].join('\n'),
    );
    try {
      const connection = resolveConnection();
      expect(connection.server.toString()).toBe('http://profile.test:9000/');
      expect(connection.token).toBe('ci-secret');
    } finally {
      restoreEnv(snapshot);
    }
  });

  it('does not apply a profile token when an explicit server overrides it', () => {
    const snapshot = snapshotEnv('WEFT_ADDR', 'WEFT_TOKEN', 'WEFT_HOME');
    const home = makeHome();
    Bun.env['WEFT_HOME'] = home;
    delete Bun.env['WEFT_ADDR'];
    delete Bun.env['WEFT_TOKEN'];
    writeConfig(
      home,
      ['default_profile = "main"', '', '[profiles.main]', 'token = "profile-token"'].join('\n'),
    );
    try {
      const connection = resolveConnection({ server: 'http://explicit.test' });
      expect(connection.server.toString()).toBe('http://explicit.test/');
      expect(connection.token).toBeUndefined();
    } finally {
      restoreEnv(snapshot);
    }
  });

  it('keeps the profile token when an explicit server names the same destination', () => {
    const snapshot = snapshotEnv('WEFT_ADDR', 'WEFT_TOKEN', 'WEFT_HOME');
    const home = makeHome();
    Bun.env['WEFT_HOME'] = home;
    delete Bun.env['WEFT_ADDR'];
    delete Bun.env['WEFT_TOKEN'];
    writeConfig(
      home,
      [
        'default_profile = "main"',
        '',
        '[profiles.main]',
        'server = "http://profile.test:9000"',
        'token = "profile-token"',
      ].join('\n'),
    );
    try {
      // A trailing slash is the same destination as the profile's server, so
      // the profile token must still apply.
      const connection = resolveConnection({ server: 'http://profile.test:9000/' });
      expect(connection.server.toString()).toBe('http://profile.test:9000/');
      expect(connection.token).toBe('profile-token');
    } finally {
      restoreEnv(snapshot);
    }
  });

  it('drops the profile token when an explicit server names a different destination', () => {
    const snapshot = snapshotEnv('WEFT_ADDR', 'WEFT_TOKEN', 'WEFT_HOME');
    const home = makeHome();
    Bun.env['WEFT_HOME'] = home;
    delete Bun.env['WEFT_ADDR'];
    delete Bun.env['WEFT_TOKEN'];
    writeConfig(
      home,
      [
        'default_profile = "main"',
        '',
        '[profiles.main]',
        'server = "http://profile.test:9000"',
        'token = "profile-token"',
      ].join('\n'),
    );
    try {
      const connection = resolveConnection({ server: 'http://elsewhere.test:9000' });
      expect(connection.server.toString()).toBe('http://elsewhere.test:9000/');
      expect(connection.token).toBeUndefined();
    } finally {
      restoreEnv(snapshot);
    }
  });

  it('keeps the profile token when WEFT_ADDR names the same destination', () => {
    const snapshot = snapshotEnv('WEFT_ADDR', 'WEFT_TOKEN', 'WEFT_HOME');
    const home = makeHome();
    Bun.env['WEFT_HOME'] = home;
    Bun.env['WEFT_ADDR'] = 'http://profile.test:9000';
    delete Bun.env['WEFT_TOKEN'];
    writeConfig(
      home,
      [
        'default_profile = "main"',
        '',
        '[profiles.main]',
        'server = "http://profile.test:9000"',
        'token = "profile-token"',
      ].join('\n'),
    );
    try {
      const connection = resolveConnection();
      expect(connection.server.toString()).toBe('http://profile.test:9000/');
      expect(connection.token).toBe('profile-token');
    } finally {
      restoreEnv(snapshot);
    }
  });

  it('falls back to the run lockfile for CLI callers', () => {
    const snapshot = snapshotEnv('WEFT_ADDR', 'WEFT_HOME');
    const home = makeHome();
    Bun.env['WEFT_HOME'] = home;
    delete Bun.env['WEFT_ADDR'];
    writeLockfile(home, 'http://127.0.0.1:4321');
    try {
      const connection = resolveConnection({ includeRunLockfile: true });
      expect(connection.server.toString()).toBe('http://127.0.0.1:4321/');
    } finally {
      restoreEnv(snapshot);
    }
  });

  it('ignores the run lockfile when includeRunLockfile is false', () => {
    const snapshot = snapshotEnv('WEFT_ADDR', 'WEFT_HOME');
    const home = makeHome();
    Bun.env['WEFT_HOME'] = home;
    delete Bun.env['WEFT_ADDR'];
    writeLockfile(home, 'http://127.0.0.1:4321');
    try {
      const connection = resolveConnection({ includeRunLockfile: false });
      expect(connection.server.toString()).toBe(`${DEFAULT_WEFT_ADDRESS}/`);
    } finally {
      restoreEnv(snapshot);
    }
  });

  it('throws ConnectionConfigurationError on a malformed config file', () => {
    const snapshot = snapshotEnv('WEFT_ADDR', 'WEFT_HOME');
    const home = makeHome();
    Bun.env['WEFT_HOME'] = home;
    delete Bun.env['WEFT_ADDR'];
    writeConfig(home, 'server = "unterminated');
    try {
      expect(() => resolveConnection()).toThrow(ConnectionConfigurationError);
    } finally {
      restoreEnv(snapshot);
    }
  });

  it('throws ConnectionConfigurationError naming the offending value on a malformed server URL', () => {
    const snapshot = snapshotEnv('WEFT_ADDR', 'WEFT_HOME');
    const home = makeHome();
    Bun.env['WEFT_HOME'] = home;
    delete Bun.env['WEFT_ADDR'];
    try {
      expect(() => resolveConnection({ server: 'not a url' })).toThrow(
        ConnectionConfigurationError,
      );
      expect(() => resolveConnection({ server: 'not a url' })).toThrow(
        /Invalid server URL 'not a url'/,
      );
    } finally {
      restoreEnv(snapshot);
    }
  });

  it('names the profile server in the error when a profile resolves a malformed URL', () => {
    const snapshot = snapshotEnv('WEFT_ADDR', 'WEFT_TOKEN', 'WEFT_PROFILE', 'WEFT_HOME');
    const home = makeHome();
    Bun.env['WEFT_HOME'] = home;
    delete Bun.env['WEFT_ADDR'];
    delete Bun.env['WEFT_TOKEN'];
    delete Bun.env['WEFT_PROFILE'];
    writeConfig(
      home,
      ['default_profile = "main"', '', '[profiles.main]', 'server = "http://[::bad"'].join('\n'),
    );
    try {
      expect(() => resolveConnection()).toThrow(/Invalid server URL 'http:\/\/\[::bad'/);
    } finally {
      restoreEnv(snapshot);
    }
  });
});

describe('writeRunLockfile / removeRunLockfile', () => {
  it('round-trips through Bun.write: a written lockfile is picked up by resolveConnection, and removal drops it', async () => {
    const snapshot = snapshotEnv('WEFT_ADDR', 'WEFT_TOKEN', 'WEFT_PROFILE', 'WEFT_HOME');
    const home = makeHome();
    Bun.env['WEFT_HOME'] = home;
    delete Bun.env['WEFT_ADDR'];
    delete Bun.env['WEFT_TOKEN'];
    delete Bun.env['WEFT_PROFILE'];
    try {
      await writeRunLockfile('http://127.0.0.1:9999');
      const withLockfile = resolveConnection();
      expect(withLockfile.server.toString()).toBe('http://127.0.0.1:9999/');

      await removeRunLockfile('http://127.0.0.1:9999');
      const withoutLockfile = resolveConnection();
      expect(withoutLockfile.server.toString()).toBe(`${DEFAULT_WEFT_ADDRESS}/`);
    } finally {
      restoreEnv(snapshot);
    }
  });

  it('falls back to fsPromises.writeFile when Bun is unavailable (Node-only runtime)', async () => {
    const snapshot = snapshotEnv('WEFT_HOME');
    const home = makeHome();
    Bun.env['WEFT_HOME'] = home;
    setPortableRuntimeTestOverridesForTesting({ bun: undefined });
    try {
      await writeRunLockfile('http://127.0.0.1:8888');
      const lockfilePath = join(home, 'run');
      expect(existsSync(lockfilePath)).toBe(true);
      expect(JSON.parse(readFileSync(lockfilePath, 'utf8'))).toEqual({
        server: 'http://127.0.0.1:8888',
      });
    } finally {
      setPortableRuntimeTestOverridesForTesting(undefined);
      restoreEnv(snapshot);
    }
  });

  it('throws when neither Bun nor Node process.getBuiltinModule is available (browser/edge)', async () => {
    setPortableRuntimeTestOverridesForTesting({ process: undefined });
    try {
      await expect(writeRunLockfile('http://127.0.0.1:8888')).rejects.toThrow(
        /requires Bun or Node 22\.5\+ \(process\.getBuiltinModule\)/,
      );
    } finally {
      setPortableRuntimeTestOverridesForTesting(undefined);
    }
  });
});

describe('~/.weft/config resolution outside Bun', () => {
  it('ignores an on-disk config file when Bun is unavailable, because Bun.TOML cannot parse it', () => {
    const snapshot = snapshotEnv('WEFT_ADDR', 'WEFT_TOKEN', 'WEFT_PROFILE', 'WEFT_HOME');
    const home = makeHome();
    Bun.env['WEFT_HOME'] = home;
    delete Bun.env['WEFT_ADDR'];
    delete Bun.env['WEFT_TOKEN'];
    delete Bun.env['WEFT_PROFILE'];
    writeConfig(
      home,
      [
        'default_profile = "main"',
        '',
        '[profiles.main]',
        'server = "https://profile.example.com"',
      ].join('\n'),
    );
    setPortableRuntimeTestOverridesForTesting({ bun: undefined });
    try {
      const connection = resolveConnection();
      expect(connection.server.toString()).toBe(`${DEFAULT_WEFT_ADDRESS}/`);
    } finally {
      setPortableRuntimeTestOverridesForTesting(undefined);
      restoreEnv(snapshot);
    }
  });
});
