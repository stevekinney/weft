/**
 * Real-browser `HttpClient` construction smoke test — regression coverage for
 * #713.
 *
 * `@lostgradient/weft/client` is documented and positioned as the browser
 * client for `weft-console`-style SPAs, but `new HttpClient({ baseUrl, token })`
 * used to throw unconditionally in any real browser: the constructor
 * synchronously called through to `resolveConnection`, which read
 * `Bun.env['WEFT_PROFILE']` as a bare global reference (`ReferenceError: Bun is
 * not defined`) and statically imported `node:fs`/`node:fs/promises` — a static
 * `node:*` import a bundler externalizes to an empty stub rather than failing
 * the build, deferring the crash to the first `new HttpClient(...)` call at
 * runtime. `src/core/types/definition-schema-to-json.ts` (reachable from the
 * same `/client` bundle via the catalog's Valibot schema adapter) statically
 * imported `createRequire` from `node:module` for the same reason.
 *
 * This test builds the real `/client` entry point for the browser — the same
 * bundling posture a Vite/Rollup consumer uses — and runs it in a real
 * Chromium tab with no `Bun` global and no Node built-ins available
 * (Playwright's default browser context), following the harness pattern in
 * `src/storage/indexeddb-browser.test.ts` and
 * `src/service-worker/service-worker-browser.test.ts`.
 *
 * The build step shells out to the `bun build` CLI (`Bun.spawn`) rather than
 * calling the in-process `Bun.build()` API: `Bun.build()` invoked from inside
 * a running `bun:test` worker fails to resolve this project's cross-directory
 * relative imports (e.g. `src/cli/generated/*` importing
 * `../operation-client-runtime.ts`) even though the identical entry point
 * bundles cleanly via the `bun build` CLI or a plain (non-test) script. A
 * subprocess sidesteps whatever resolver state `bun:test` leaks into nested
 * `Bun.build()` calls.
 *
 * ## Running
 *
 * Gate: `WEFT_BROWSER_SMOKE=1` must be set (the shared flag for all real-browser
 * smokes; see `bun run test:browser-smoke`). Otherwise all tests skip. This
 * file does NOT run in the default `bun test` pass.
 *
 * Browser provisioning: `bunx playwright install chromium` (run once).
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Browser, BrowserContext } from 'playwright';
import { chromium } from 'playwright';

const shouldRun = Bun.env['WEFT_BROWSER_SMOKE'] === '1';
const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url));

/**
 * Build the real `@lostgradient/weft/client` entry point as a browser-target
 * IIFE and return its source so it can be served as a static asset. Writes a
 * temporary build entry (re-exporting `HttpClient` onto `globalThis`) and
 * bundles it with the `bun build` CLI — see the module docstring for why this
 * shells out instead of calling `Bun.build()` in-process.
 */
async function buildClientScript(): Promise<string> {
  const clientEntryPath = fileURLToPath(new URL('./index.ts', import.meta.url));
  const temporaryDirectory = mkdtempSync(join(tmpdir(), 'weft-http-client-build-'));
  const entryPath = join(temporaryDirectory, 'entry.ts');
  const outfilePath = join(temporaryDirectory, 'out.js');

  await Bun.write(
    entryPath,
    `import { HttpClient } from ${JSON.stringify(clientEntryPath)};
(globalThis as unknown as Record<string, unknown>)['HttpClient'] = HttpClient;
`,
  );

  try {
    const proc = Bun.spawn(
      ['bun', 'build', entryPath, '--target=browser', '--format=iife', `--outfile=${outfilePath}`],
      { cwd: repositoryRoot, stdout: 'pipe', stderr: 'pipe' },
    );
    const [exitCode, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
    if (exitCode !== 0) {
      throw new Error(`Failed to build @lostgradient/weft/client for browser: ${stderr}`);
    }
    return await Bun.file(outfilePath).text();
  } finally {
    rmSync(temporaryDirectory, { force: true, recursive: true });
  }
}

function buildTestPageHtml(clientScriptUrl: string): string {
  return `<!doctype html>
<html>
<head><title>HttpClient Browser Smoke</title></head>
<body>
<script src="${clientScriptUrl}"></script>
</body>
</html>`;
}

let browser: Browser;
let context: BrowserContext;
let server: ReturnType<typeof Bun.serve>;
let clientScriptSource: string;
let baseUrl: string;

(shouldRun ? describe : describe.skip)('HttpClient — real Chromium construction', () => {
  beforeAll(async () => {
    clientScriptSource = await buildClientScript();

    server = Bun.serve({
      port: 0,
      fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === '/client.js') {
          return new Response(clientScriptSource, {
            headers: { 'Content-Type': 'application/javascript' },
          });
        }
        if (url.pathname === '/') {
          return new Response(buildTestPageHtml('/client.js'), {
            headers: { 'Content-Type': 'text/html' },
          });
        }
        if (url.pathname === '/v1/health') {
          return Response.json({ status: 'ok' });
        }
        return new Response(null, { status: 404 });
      },
    });

    baseUrl = `http://127.0.0.1:${server.port}`;

    browser = await chromium.launch({ headless: true });
    context = await browser.newContext();
  });

  afterAll(async () => {
    await context?.close();
    await browser?.close();
    await server?.stop(true);
  });

  it('new HttpClient({ baseUrl, token }) does not throw with no Bun global and no Node built-ins', async () => {
    const page = await context.newPage();
    try {
      await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(
        () => typeof (globalThis as Record<string, unknown>)['HttpClient'] === 'function',
      );

      const result = await page.evaluate((serverBaseUrl) => {
        type HttpClientCtor = new (options: { baseUrl: string; token: string }) => {
          baseUrl: string;
        };
        const bunGlobal = (globalThis as Record<string, unknown>)['Bun'];
        const requireGlobal = (globalThis as Record<string, unknown>)['require'];
        const Cls = (globalThis as Record<string, unknown>)['HttpClient'] as HttpClientCtor;
        try {
          const client = new Cls({ baseUrl: serverBaseUrl, token: 'test-token' });
          return {
            threw: false,
            message: null as string | null,
            resolvedBaseUrl: client.baseUrl,
            hadBunGlobal: typeof bunGlobal !== 'undefined',
            hadRequireGlobal: typeof requireGlobal !== 'undefined',
          };
        } catch (error) {
          return {
            threw: true,
            message: error instanceof Error ? error.message : String(error),
            resolvedBaseUrl: null as string | null,
            hadBunGlobal: typeof bunGlobal !== 'undefined',
            hadRequireGlobal: typeof requireGlobal !== 'undefined',
          };
        }
      }, baseUrl);

      // Sanity-check the harness itself: a real Chromium page must not expose
      // `Bun` or `require`, or this test would pass for the wrong reason.
      expect(result.hadBunGlobal).toBe(false);
      expect(result.hadRequireGlobal).toBe(false);

      expect(result.threw).toBe(false);
      expect(result.message).toBeNull();
      expect(result.resolvedBaseUrl).toBe(baseUrl);
    } finally {
      await page.close();
    }
  }, 30_000);

  it('a browser-constructed HttpClient can make a real request against a live server', async () => {
    const page = await context.newPage();
    try {
      await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(
        () => typeof (globalThis as Record<string, unknown>)['HttpClient'] === 'function',
      );

      const health = await page.evaluate(async (serverBaseUrl) => {
        type HttpClientCtor = new (options: { baseUrl: string }) => {
          headers: Record<string, string>;
        };
        const Cls = (globalThis as Record<string, unknown>)['HttpClient'] as HttpClientCtor;
        const client = new Cls({ baseUrl: serverBaseUrl });
        const response = await fetch(`${serverBaseUrl}/v1/health`, {
          headers: client.headers,
        });
        return response.json();
      }, baseUrl);

      expect(health).toEqual({ status: 'ok' });
    } finally {
      await page.close();
    }
  }, 30_000);
});
