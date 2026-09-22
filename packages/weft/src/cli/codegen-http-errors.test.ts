import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
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
  it('reports 401 responses with status and URL', async () => {
    const server = serveOnce(
      () => new Response('nope', { status: 401, statusText: 'Unauthorized' }),
    );
    try {
      const dir = makeTempDir();
      const out = join(dir, 'weft.d.ts');
      const result = await executeCodegen({
        server: server.url.toString(),
        out,
        timeoutMs: 30_000,
      });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('401');
      expect(result.stderr).toContain(server.url.toString());
      expect(existsSync(out)).toBe(false);
    } finally {
      await server.stop(true);
    }
  });

  it('reports 500 responses with status and URL', async () => {
    const server = serveOnce(
      () => new Response('boom', { status: 500, statusText: 'Internal Server Error' }),
    );
    try {
      const dir = makeTempDir();
      const out = join(dir, 'weft.d.ts');
      const result = await executeCodegen({
        server: server.url.toString(),
        out,
        timeoutMs: 30_000,
      });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('500');
    } finally {
      await server.stop(true);
    }
  });

  it('reports a content-type mismatch when the server returns HTML', async () => {
    const server = serveOnce(
      () => new Response('<html>not json</html>', { headers: { 'content-type': 'text/html' } }),
    );
    try {
      const dir = makeTempDir();
      const out = join(dir, 'weft.d.ts');
      const result = await executeCodegen({
        server: server.url.toString(),
        out,
        timeoutMs: 30_000,
      });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('content-type');
    } finally {
      await server.stop(true);
    }
  });

  it('reports a parse error when the body claims JSON but is malformed', async () => {
    const server = serveOnce(
      () => new Response('not actually json', { headers: { 'content-type': 'application/json' } }),
    );
    try {
      const dir = makeTempDir();
      const out = join(dir, 'weft.d.ts');
      const result = await executeCodegen({
        server: server.url.toString(),
        out,
        timeoutMs: 30_000,
      });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('failed to parse response body');
      expect(existsSync(out)).toBe(false);
    } finally {
      await server.stop(true);
    }
  });

  it('sends no Authorization header when neither --token nor WEFT_TOKEN is set', async () => {
    let observedAuth: string | null | undefined;
    const server = serveOnce((request) => {
      observedAuth = request.headers.get('authorization');
      return new Response(Bun.file(REGISTRY_FIXTURE), {
        headers: { 'content-type': 'application/json' },
      });
    });
    const prior = Bun.env['WEFT_TOKEN'];
    delete Bun.env['WEFT_TOKEN'];
    try {
      const dir = makeTempDir();
      const out = join(dir, 'weft.d.ts');
      const result = await executeCodegen({
        server: server.url.toString(),
        out,
        timeoutMs: 30_000,
      });
      expect(result.exitCode).toBe(0);
      expect(observedAuth).toBeNull();
    } finally {
      if (prior !== undefined) Bun.env['WEFT_TOKEN'] = prior;
      await server.stop(true);
    }
  });

  it('reports a clear diagnostic when the host is unreachable', async () => {
    const dir = makeTempDir();
    const out = join(dir, 'weft.d.ts');
    // Port 1 is reserved (TCPMUX). On every modern OS the connection is
    // refused or filtered, so `fetch` throws synchronously after a
    // short kernel-level rejection — fast enough not to trip the
    // 30s default timeout.
    const result = await executeCodegen({
      server: 'http://127.0.0.1:1/',
      out,
      timeoutMs: 30_000,
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('127.0.0.1:1');
  });

  it('reaches /base/api/v1/registry when given a path-prefixed server URL', async () => {
    let observedPath: string | null | undefined;
    const server = serveOnce((request) => {
      const url = new URL(request.url);
      observedPath = url.pathname;
      if (url.pathname === '/base/api/v1/registry') {
        return new Response(Bun.file(REGISTRY_FIXTURE), {
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('not found', { status: 404 });
    });
    try {
      const dir = makeTempDir();
      const out = join(dir, 'weft.d.ts');
      const url = new URL('/base', server.url).toString();
      const result = await executeCodegen({ server: url, out, timeoutMs: 30_000 });
      expect(result.exitCode).toBe(0);
      expect(observedPath).toBe('/base/api/v1/registry');
    } finally {
      await server.stop(true);
    }
  });
});
