import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { executeCodegen } from './codegen.ts';

const FIXTURE_DIR = resolve(import.meta.dir, '__fixtures__/codegen');
const REGISTRY_FIXTURE = join(FIXTURE_DIR, 'registry.json');

const tempDirs: string[] = [];
function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'weft-codegen-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

type FetchHandler = (request: Request) => Response | Promise<Response>;
function serveOnce(handler: FetchHandler) {
  return Bun.serve({ port: 0, fetch: handler });
}

describe('executeCodegen HTTP fetch path', () => {
  it('sends Authorization: Bearer when --token is provided', async () => {
    let observedAuth: string | null | undefined;
    const server = serveOnce((request) => {
      observedAuth = request.headers.get('authorization');
      return new Response(Bun.file(REGISTRY_FIXTURE), {
        headers: { 'content-type': 'application/json' },
      });
    });
    try {
      const dir = makeTempDir();
      const out = join(dir, 'weft.d.ts');
      const result = await executeCodegen({
        server: server.url.toString(),
        token: 'sekret',
        out,
        timeoutMs: 30_000,
      });
      expect(result.exitCode).toBe(0);
      expect(observedAuth).toBe('Bearer sekret');
    } finally {
      await server.stop(true);
    }
  });

  it('uses WEFT_TOKEN when --token is not provided', async () => {
    let observedAuth: string | null | undefined;
    const server = serveOnce((request) => {
      observedAuth = request.headers.get('authorization');
      return new Response(Bun.file(REGISTRY_FIXTURE), {
        headers: { 'content-type': 'application/json' },
      });
    });
    const prior = Bun.env['WEFT_TOKEN'];
    Bun.env['WEFT_TOKEN'] = 'env-token';
    try {
      const dir = makeTempDir();
      const out = join(dir, 'weft.d.ts');
      const result = await executeCodegen({
        server: server.url.toString(),
        out,
        timeoutMs: 30_000,
      });
      expect(result.exitCode).toBe(0);
      expect(observedAuth).toBe('Bearer env-token');
    } finally {
      if (prior === undefined) delete Bun.env['WEFT_TOKEN'];
      else Bun.env['WEFT_TOKEN'] = prior;
      await server.stop(true);
    }
  });

  it('--token overrides WEFT_TOKEN', async () => {
    let observedAuth: string | null | undefined;
    const server = serveOnce((request) => {
      observedAuth = request.headers.get('authorization');
      return new Response(Bun.file(REGISTRY_FIXTURE), {
        headers: { 'content-type': 'application/json' },
      });
    });
    const prior = Bun.env['WEFT_TOKEN'];
    Bun.env['WEFT_TOKEN'] = 'env-token';
    try {
      const dir = makeTempDir();
      const out = join(dir, 'weft.d.ts');
      await executeCodegen({
        server: server.url.toString(),
        token: 'flag-token',
        out,
        timeoutMs: 30_000,
      });
      expect(observedAuth).toBe('Bearer flag-token');
    } finally {
      if (prior === undefined) delete Bun.env['WEFT_TOKEN'];
      else Bun.env['WEFT_TOKEN'] = prior;
      await server.stop(true);
    }
  });

  it('uses WEFT_ADDR and WEFT_TOKEN through the shared connection resolver', async () => {
    let observedAuth: string | null | undefined;
    let observedUrl: string | undefined;
    const server = serveOnce((request) => {
      observedAuth = request.headers.get('authorization');
      observedUrl = request.url;
      return new Response(Bun.file(REGISTRY_FIXTURE), {
        headers: { 'content-type': 'application/json' },
      });
    });
    const priorAddress = Bun.env['WEFT_ADDR'];
    const priorToken = Bun.env['WEFT_TOKEN'];
    Bun.env['WEFT_ADDR'] = server.url.toString();
    Bun.env['WEFT_TOKEN'] = 'environment-token';
    try {
      const dir = makeTempDir();
      const out = join(dir, 'weft.d.ts');
      const result = await executeCodegen({ out, timeoutMs: 30_000 });
      expect(result.exitCode).toBe(0);
      expect(observedAuth).toBe('Bearer environment-token');
      expect(observedUrl).toBe(new URL('/api/v1/registry', server.url).toString());
    } finally {
      if (priorAddress === undefined) delete Bun.env['WEFT_ADDR'];
      else Bun.env['WEFT_ADDR'] = priorAddress;
      if (priorToken === undefined) delete Bun.env['WEFT_TOKEN'];
      else Bun.env['WEFT_TOKEN'] = priorToken;
      await server.stop(true);
    }
  });

  it('reports malformed connection configuration as a user diagnostic', async () => {
    const home = makeTempDir();
    writeFileSync(join(home, 'config'), 'server = "missing-closing-quote');
    const out = join(home, 'weft.d.ts');
    const priorHome = Bun.env['WEFT_HOME'];
    const priorAddress = Bun.env['WEFT_ADDR'];
    Bun.env['WEFT_HOME'] = home;
    delete Bun.env['WEFT_ADDR'];

    try {
      const result = await executeCodegen({ out, timeoutMs: 30_000 });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('codegen: Failed to read connection configuration');
      expect(existsSync(out)).toBe(false);
    } finally {
      if (priorHome === undefined) delete Bun.env['WEFT_HOME'];
      else Bun.env['WEFT_HOME'] = priorHome;
      if (priorAddress === undefined) delete Bun.env['WEFT_ADDR'];
      else Bun.env['WEFT_ADDR'] = priorAddress;
    }
  });

  it('reports a malformed --server as a CommandOutput, not a thrown TypeError', async () => {
    const dir = makeTempDir();
    const out = join(dir, 'weft.d.ts');
    const priorAddress = Bun.env['WEFT_ADDR'];
    delete Bun.env['WEFT_ADDR'];
    try {
      // `resolveConnection` raises a `ConnectionConfigurationError` for a
      // malformed server value; `executeCodegen` must translate that into a
      // clean diagnostic naming the offending URL rather than rejecting.
      const result = await executeCodegen({
        server: 'not a url',
        out,
        timeoutMs: 30_000,
      });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("codegen: Invalid server URL 'not a url'");
      expect(existsSync(out)).toBe(false);
    } finally {
      if (priorAddress === undefined) delete Bun.env['WEFT_ADDR'];
      else Bun.env['WEFT_ADDR'] = priorAddress;
    }
  });

  it('reports a malformed WEFT_ADDR as a CommandOutput diagnostic', async () => {
    const dir = makeTempDir();
    const out = join(dir, 'weft.d.ts');
    const priorAddress = Bun.env['WEFT_ADDR'];
    Bun.env['WEFT_ADDR'] = ':::not-a-url:::';
    try {
      const result = await executeCodegen({ out, timeoutMs: 30_000 });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("codegen: Invalid server URL ':::not-a-url:::'");
      expect(existsSync(out)).toBe(false);
    } finally {
      if (priorAddress === undefined) delete Bun.env['WEFT_ADDR'];
      else Bun.env['WEFT_ADDR'] = priorAddress;
    }
  });

  it('names the actual invalid URL when it comes from a profile (not --server/WEFT_ADDR)', async () => {
    // Regression for the misleading empty-URL diagnostic: when neither --server
    // nor WEFT_ADDR is set, the malformed URL resolves from the profile, and the
    // diagnostic must still report the offending value rather than an empty
    // string.
    const home = makeTempDir();
    writeFileSync(
      join(home, 'config'),
      ['default_profile = "main"', '', '[profiles.main]', 'server = "http://[::bad"'].join('\n'),
    );
    const out = join(home, 'weft.d.ts');
    const priorHome = Bun.env['WEFT_HOME'];
    const priorAddress = Bun.env['WEFT_ADDR'];
    const priorProfile = Bun.env['WEFT_PROFILE'];
    Bun.env['WEFT_HOME'] = home;
    delete Bun.env['WEFT_ADDR'];
    // resolveConnectionContext reads WEFT_PROFILE before the config's
    // default_profile, so an externally-set WEFT_PROFILE would select a profile
    // other than "main" and break this test in CI/dev environments. Clear it so
    // the malformed URL resolves from the config's "main" profile as intended.
    delete Bun.env['WEFT_PROFILE'];
    try {
      const result = await executeCodegen({ out, timeoutMs: 30_000 });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("codegen: Invalid server URL 'http://[::bad'");
      expect(result.stderr).not.toContain("URL ''");
      expect(existsSync(out)).toBe(false);
    } finally {
      if (priorHome === undefined) delete Bun.env['WEFT_HOME'];
      else Bun.env['WEFT_HOME'] = priorHome;
      if (priorAddress === undefined) delete Bun.env['WEFT_ADDR'];
      else Bun.env['WEFT_ADDR'] = priorAddress;
      if (priorProfile === undefined) delete Bun.env['WEFT_PROFILE'];
      else Bun.env['WEFT_PROFILE'] = priorProfile;
    }
  });

  it('times out cleanly against a hanging server', async () => {
    const server = serveOnce(() => new Promise<Response>(() => {}));
    try {
      const dir = makeTempDir();
      const out = join(dir, 'weft.d.ts');
      const result = await executeCodegen({
        server: server.url.toString(),
        out,
        timeoutMs: 50,
      });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('timed out after 50ms');
      expect(existsSync(out)).toBe(false);
    } finally {
      await server.stop(true);
    }
  });
});
