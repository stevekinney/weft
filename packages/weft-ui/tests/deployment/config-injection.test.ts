/**
 * Config-injection test (plan §3, §3.3, §3.4, T9.1; acceptance checklist
 * §11.5: "config-injection test that the same bundle boots in all three
 * modes"). Exercises `readRuntimeConfig()` (`src/lib/config.ts`) and
 * `createClient()` (`src/lib/client.ts`) TOGETHER, end to end from the raw
 * `<script id="weft-ui-config">` JSON text a mount would inject, through
 * to the constructed `HttpClient` — the individual pieces already have
 * exhaustive unit coverage in `config.test.ts`/`client.test.ts`; this file's
 * job is proving the three documented mount shapes (§3.1 Bun mount, §3.3
 * Service Worker, §3.4 standalone/cross-origin) each round-trip correctly
 * through the SAME pipeline the built bundle runs at boot.
 *
 * Unit-level per PROJECT-BRIEF, not a DOM/browser test: `Document` is the
 * same hand-built double `config.test.ts` uses (`readRuntimeConfig()`'s only
 * dependency is `getElementById`). `HttpClient` has no public getter for its
 * resolved `eventTransport` (`client.test.ts`'s own comment on this) — the
 * honest assertion available here is "construction with `eventTransport:
 * 'sse'` succeeds and the client is a real `HttpClient`", not a runtime
 * transport probe.
 */
import { HttpClient } from '@lostgradient/weft/client';
import { describe, expect, test } from 'bun:test';

import { createClient } from '../../src/lib/client.ts';
import { readRuntimeConfig } from '../../src/lib/config.ts';

const CONFIG_ELEMENT_ID = 'weft-ui-config';
const CONSOLE_ORIGIN = 'https://weft-ui.example.com';

function documentWithConfigBlock(json: unknown): Document {
  const text = JSON.stringify(json);
  return {
    getElementById(id: string) {
      if (id !== CONFIG_ELEMENT_ID) return null;
      return { textContent: text } as HTMLElement;
    },
  } as unknown as Document;
}

describe('config injection — Service Worker mode (plan §3.3)', () => {
  test('a host page config block with baseUrl "/weft" and eventTransport "sse" boots a working client', () => {
    const doc = documentWithConfigBlock({ baseUrl: '/weft', eventTransport: 'sse' });

    const config = readRuntimeConfig(doc);
    expect(config).toEqual({ baseUrl: '/weft', eventTransport: 'sse' });

    const client = createClient(config, CONSOLE_ORIGIN);
    expect(client).toBeInstanceOf(HttpClient);
    // Same-origin-relative baseUrl resolves against the host page's own
    // origin, exactly as plan §3.3 describes ("the console boots with
    // runtime config { baseUrl: '/weft' } so HttpClient requests hit the
    // SW's fetch listener").
    expect(client.baseUrl).toBe(`${CONSOLE_ORIGIN}/weft`);
  });
});

describe('config injection — Bun server mount (plan §3.1)', () => {
  test('an empty-baseUrl config block (same origin, no transport override) boots a working client', () => {
    const doc = documentWithConfigBlock({ baseUrl: '' });

    const config = readRuntimeConfig(doc);
    expect(config).toEqual({ baseUrl: '' });

    const client = createClient(config, CONSOLE_ORIGIN);
    expect(client).toBeInstanceOf(HttpClient);
    expect(client.baseUrl).toBe(CONSOLE_ORIGIN);
  });
});

describe('config injection — standalone / cross-origin mode (plan §3.4)', () => {
  test('an absolute cross-origin baseUrl plus a static header boots a working client, headers intact', () => {
    const doc = documentWithConfigBlock({
      baseUrl: 'https://weft-api.example.com',
      eventTransport: 'sse',
      headers: { 'X-API-Key': 'operator-key' },
    });

    const config = readRuntimeConfig(doc);
    expect(config).toEqual({
      baseUrl: 'https://weft-api.example.com',
      eventTransport: 'sse',
      headers: { 'X-API-Key': 'operator-key' },
    });

    const client = createClient(config, CONSOLE_ORIGIN);
    expect(client).toBeInstanceOf(HttpClient);
    // Absolute baseUrl passes through unchanged — never resolved against the
    // console's own origin (that would defeat the point of cross-origin mode).
    expect(client.baseUrl).toBe('https://weft-api.example.com');
    expect(client.headers['x-api-key']).toBe('operator-key');
  });
});
