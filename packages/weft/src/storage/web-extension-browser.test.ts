/**
 * Real-browser WebExtensionStorage smoke test.
 *
 * Validates the `WebExtensionStorage` adapter against a real Chromium extension
 * runtime (real `chrome.storage.local`), not the deterministic fake drivers the
 * default `web-extension.test.ts` suite uses. It rounds bytes through the
 * structured `chrome.storage.local` envelope: put/get/keys/count/deletePrefix.
 *
 * ## Running
 *
 * Gate: `WEFT_BROWSER_SMOKE=1` must be set (the same flag the sibling Service
 * Worker and `browser-smoke` CI job use). Otherwise the suite skips and does not
 * run in the default `bun test` pass.
 *
 * Browser provisioning: `bunx playwright install --with-deps chromium`. The
 * pinned binary is resolved by Playwright — no manual discovery.
 *
 * ## Architecture
 *
 * The adapter is bundled into an unpacked Manifest V3 extension whose content
 * script runs the round-trip and reports the result. The extension is loaded via
 * Playwright's `launchPersistentContext` (the only context type that can load an
 * unpacked extension). Two Chromium facts shape this harness:
 *
 *  1. Playwright's `headless: true` option does NOT load unpacked extensions.
 *     Launching with `headless: false` plus an explicit `--headless=new` arg runs
 *     Chromium's real offscreen headless mode AND loads the extension — no xvfb
 *     or display needed on CI.
 *  2. MV3 content scripts execute in an isolated world with their own `window`,
 *     so a value set on `window` is invisible to `page.evaluate` (which runs in
 *     the page's main world). The shared surface between the two worlds is the
 *     DOM, so the content script reports its result through a DOM attribute and
 *     the test reads it back with `page.waitForFunction` + `getAttribute`.
 */

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { BrowserContext } from 'playwright';
import { chromium } from 'playwright';

const shouldRun = Bun.env['WEFT_BROWSER_SMOKE'] === '1';

/** Attribute on `<html>` the content script writes its JSON result into. */
const RESULT_ATTRIBUTE = 'data-weft-smoke-result';

const webExtensionStorageSource = fileURLToPath(new URL('./web-extension.ts', import.meta.url));

type SmokeResult =
  | {
      readonly ok: true;
      readonly afterDelete: boolean;
      readonly count: number;
      readonly keys: readonly string[];
      readonly value: readonly number[];
    }
  | {
      readonly ok: false;
      readonly message: string;
      readonly stack?: string;
    };

/**
 * Write an unpacked MV3 extension whose content script runs the
 * `WebExtensionStorage` round-trip and reports the result through a DOM
 * attribute on `<html>` (the only surface shared with the page's main world).
 */
async function writeExtension(extensionDirectory: string): Promise<void> {
  const entrypointPath = join(extensionDirectory, 'content-script.ts');
  const manifestPath = join(extensionDirectory, 'manifest.json');

  await Bun.write(
    manifestPath,
    JSON.stringify(
      {
        content_scripts: [
          {
            js: ['content-script.js'],
            // `http://127.0.0.1/*` implies port 80 in MV3 match patterns; the
            // test page is served on an ephemeral port, so match any port.
            matches: ['http://127.0.0.1:*/*'],
            run_at: 'document_idle',
          },
        ],
        manifest_version: 3,
        name: 'Weft WebExtensionStorage Smoke',
        permissions: ['storage'],
        version: '0.0.0',
      },
      null,
      2,
    ),
  );

  await Bun.write(
    entrypointPath,
    `
import { WebExtensionStorage } from ${JSON.stringify(webExtensionStorageSource)};

const RESULT_ATTRIBUTE = ${JSON.stringify(RESULT_ATTRIBUTE)};

function report(payload) {
  // The content script runs in an isolated world; the DOM is the only surface
  // the page's main world (where page.evaluate runs) can observe.
  document.documentElement.setAttribute(RESULT_ATTRIBUTE, JSON.stringify(payload));
}

async function runSmokeTest() {
  try {
    const storage = new WebExtensionStorage({ area: 'local' });
    await storage.put('smoke:key', new Uint8Array([0, 1, 2, 255]));

    const value = await storage.get('smoke:key');
    const keys = [];
    for await (const key of storage.keys('smoke:')) keys.push(key);
    const count = await storage.count('smoke:');

    await storage.deletePrefix('smoke:');
    const afterDelete = await storage.get('smoke:key');

    report({
      ok: true,
      afterDelete: afterDelete === null,
      count,
      keys,
      value: Array.from(value ?? []),
    });
  } catch (error) {
    report({
      ok: false,
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
  }
}

void runSmokeTest();
`,
  );

  const build = await Bun.build({
    entrypoints: [entrypointPath],
    format: 'iife',
    minify: false,
    outdir: extensionDirectory,
    target: 'browser',
  });
  if (!build.success) {
    throw new Error(build.logs.map((log) => log.message).join('\n'));
  }
}

let temporaryDirectory: string;
let context: BrowserContext;
let server: ReturnType<typeof Bun.serve>;
let baseUrl: string;

(shouldRun ? describe : describe.skip)('WebExtensionStorage — real Chromium smoke', () => {
  beforeAll(async () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), 'weft-web-extension-smoke-'));
    const extensionDirectory = join(temporaryDirectory, 'extension');
    const profileDirectory = join(temporaryDirectory, 'profile');
    mkdirSync(extensionDirectory, { recursive: true });

    await writeExtension(extensionDirectory);

    // A real loopback origin so the content-script match pattern applies; the
    // page itself only needs to exist for the content script to run against.
    server = Bun.serve({
      port: 0,
      fetch() {
        return new Response('<!doctype html><title>Weft smoke</title>', {
          headers: { 'Content-Type': 'text/html' },
        });
      },
    });
    baseUrl = `http://127.0.0.1:${server.port}/`;

    // `headless: false` + an explicit `--headless=new` arg loads the unpacked
    // extension while still rendering offscreen (no display / xvfb needed).
    // `--no-sandbox` is required on GitHub-hosted Linux runners, where the
    // Chrome sandbox cannot initialize. Playwright's pinned Chromium is used.
    context = await chromium.launchPersistentContext(profileDirectory, {
      headless: false,
      args: [
        '--headless=new',
        '--no-sandbox',
        `--disable-extensions-except=${extensionDirectory}`,
        `--load-extension=${extensionDirectory}`,
      ],
    });
  });

  afterAll(async () => {
    await context?.close();
    await server?.stop(true);
    if (temporaryDirectory) {
      rmSync(temporaryDirectory, { force: true, recursive: true });
    }
  });

  it('round-trips bytes through real chrome.storage.local', async () => {
    const page = await context.newPage();
    try {
      await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });

      await page.waitForFunction(
        (attribute) => document.documentElement.getAttribute(attribute) !== null,
        RESULT_ATTRIBUTE,
        { timeout: 15_000 },
      );

      const raw = await page.evaluate(
        (attribute) => document.documentElement.getAttribute(attribute),
        RESULT_ATTRIBUTE,
      );
      const result = JSON.parse(raw ?? 'null') as SmokeResult | null;

      // Surface a content-script failure (or a missing result) as its real
      // message rather than an opaque object-diff on the `toEqual` below.
      if (result === null) {
        throw new Error('Result attribute was present but evaluated to null.');
      }
      if (!result.ok) {
        throw new Error(
          `Content script reported failure: ${result.message}\n${result.stack ?? ''}`,
        );
      }

      expect(result).toEqual({
        ok: true,
        afterDelete: true,
        count: 1,
        keys: ['smoke:key'],
        value: [0, 1, 2, 255],
      });
    } finally {
      await page.close();
    }
  }, 30_000);
});
