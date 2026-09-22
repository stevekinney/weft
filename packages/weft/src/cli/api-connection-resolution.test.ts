import { describe, expect, it } from 'bun:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { jsonRpcEndpoint } from '../client/json-rpc-request.ts';
import { resolveConnection } from '../index.ts';

describe('api connection resolution', () => {
  it('uses a named profile with env token indirection', async () => {
    const priorHome = Bun.env['WEFT_HOME'];
    const priorToken = Bun.env['PROFILE_TOKEN'];
    const home = await mkdtemp(join(tmpdir(), 'weft-home-'));
    Bun.env['WEFT_HOME'] = home;
    Bun.env['PROFILE_TOKEN'] = 'profile-secret';
    await Bun.write(
      join(home, 'config'),
      [
        'default_profile = "local"',
        '',
        '[profiles.local]',
        'server = "http://profile.example:9000"',
        'token = "env:PROFILE_TOKEN"',
      ].join('\n'),
    );

    try {
      const connection = resolveConnection({});
      expect(connection.server.toString()).toBe('http://profile.example:9000/');
      expect(connection.token).toBe('profile-secret');
    } finally {
      if (priorHome === undefined) delete Bun.env['WEFT_HOME'];
      else Bun.env['WEFT_HOME'] = priorHome;
      if (priorToken === undefined) delete Bun.env['PROFILE_TOKEN'];
      else Bun.env['PROFILE_TOKEN'] = priorToken;
    }
  });

  it('falls back to the local run lockfile before localhost', async () => {
    const priorHome = Bun.env['WEFT_HOME'];
    const priorAddress = Bun.env['WEFT_ADDR'];
    const home = await mkdtemp(join(tmpdir(), 'weft-home-'));
    Bun.env['WEFT_HOME'] = home;
    delete Bun.env['WEFT_ADDR'];
    await Bun.write(join(home, 'run'), `${JSON.stringify({ server: 'http://127.0.0.1:4321' })}\n`);

    try {
      const connection = resolveConnection({});
      expect(connection.server.toString()).toBe('http://127.0.0.1:4321/');
    } finally {
      if (priorHome === undefined) delete Bun.env['WEFT_HOME'];
      else Bun.env['WEFT_HOME'] = priorHome;
      if (priorAddress === undefined) delete Bun.env['WEFT_ADDR'];
      else Bun.env['WEFT_ADDR'] = priorAddress;
    }
  });

  it('ignores a malformed local run lockfile', async () => {
    const priorHome = Bun.env['WEFT_HOME'];
    const priorAddress = Bun.env['WEFT_ADDR'];
    const home = await mkdtemp(join(tmpdir(), 'weft-home-'));
    Bun.env['WEFT_HOME'] = home;
    delete Bun.env['WEFT_ADDR'];
    await Bun.write(join(home, 'run'), '{');

    try {
      const connection = resolveConnection({});
      expect(connection.server.toString()).toBe('http://localhost:7233/');
    } finally {
      if (priorHome === undefined) delete Bun.env['WEFT_HOME'];
      else Bun.env['WEFT_HOME'] = priorHome;
      if (priorAddress === undefined) delete Bun.env['WEFT_ADDR'];
      else Bun.env['WEFT_ADDR'] = priorAddress;
    }
  });

  it('preserves configured base paths when building the JSON-RPC endpoint', () => {
    expect(jsonRpcEndpoint(new URL('http://localhost:7233/base')).toString()).toBe(
      'http://localhost:7233/base/jsonrpc',
    );
  });
});
