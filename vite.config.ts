import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vite';

import { DEV_API_KEY } from './scripts/dev-credentials.ts';

/**
 * Dev proxy target: a local `weft` server started by `bun run dev:server`
 * (`scripts/dev-server.ts`). Override with `WEFT_API_BASE_URL` to point the
 * dev console at a different server without editing this file.
 */
const devServerTarget = process.env['WEFT_API_BASE_URL'] ?? 'http://localhost:7233';

// Everything functional is served under `/api`; a handful of discovery and
// health routes stay root-relative (see plan §0 / Appendix A). Both groups —
// plus WebSocket upgrades and unbuffered SSE — must proxy through in dev so
// realtime behavior matches production.
//
// `/jsonrpc` and `/mcp` are root-relative too (never under `/api` — see
// `weft/src/client/http-operations.ts`'s `httpClientCatalogTransport`,
// which builds its endpoint as `${baseUrl}/jsonrpc` with no `/v1`/`/api`
// segment, and `weft/src/mcp/http.ts`'s canonical `/mcp` path) but were
// missing here, so `client.operations[...]`/`client.call(...)` (every
// operation without an ergonomic `HttpClient` method — registry, metrics,
// recover-all, workers, task queues, diagnostics, …) and the System →
// Discovery → MCP "Test session" panel 404'd in dev even though the same
// requests work in a real `serve()`-mounted deployment. Confirmed via a
// live browser repro (`POST http://localhost:5173/jsonrpc` → 404) while
// building Track E2's System surfaces.
const proxiedApiPaths = [
  '/api',
  '/v1',
  '/openapi.json',
  '/openrpc.json',
  '/asyncapi.json',
  '/.well-known',
  '/jsonrpc',
  '/mcp',
];

export default defineConfig({
  plugins: [svelte()],
  server: {
    proxy: Object.fromEntries(
      proxiedApiPaths.map((path) => [
        path,
        {
          target: devServerTarget,
          changeOrigin: true,
          ws: true,
          // Server-Sent Event responses must not be buffered by the proxy —
          // Vite's proxy (http-proxy) streams by default as long as the
          // response isn't explicitly buffered, which is the case here.
          configure: (proxy) => {
            proxy.on('proxyRes', (proxyRes) => {
              if (proxyRes.headers['content-type']?.includes('text/event-stream')) {
                proxyRes.headers['cache-control'] = 'no-cache';
              }
            });

            // Authenticate the dev harness (see `scripts/dev-credentials.ts`
            // for why, and why here rather than in the runtime config). This
            // is a DEV-SERVER-ONLY seam: `vite build` never reaches this
            // code, so no token can leak into `dist/`. Both hooks are
            // needed — `proxyReq` covers REST/JSON-RPC, `proxyReqWs` covers
            // the per-workflow watch/stream WebSocket upgrades, which carry
            // their credential in the handshake headers.
            //
            // Only set the header when the caller didn't supply one, so a
            // developer pointing `WEFT_API_BASE_URL` at a real server with
            // their own credential is never silently overridden.
            proxy.on('proxyReq', (proxyReq) => {
              if (!proxyReq.getHeader('authorization')) {
                proxyReq.setHeader('authorization', `Bearer ${DEV_API_KEY}`);
              }
            });
            proxy.on('proxyReqWs', (proxyReq) => {
              if (!proxyReq.getHeader('authorization')) {
                proxyReq.setHeader('authorization', `Bearer ${DEV_API_KEY}`);
              }
            });
          },
        },
      ]),
    ),
  },
  build: {
    sourcemap: true,
    // Written to `dist/.vite/manifest.json`: maps each source entry (e.g.
    // `src/routes/dashboard/index.svelte`) to its exact built `file` and
    // associated `css`. `scripts/check-bundle-size.ts` (plan §12, T9.3)
    // reads this to resolve each route's real output file precisely —
    // hashed chunk names can't be pattern-matched safely (Rollup's hash
    // alphabet includes `-`, so `workers-<hash>.js` and
    // `workers-data-<hash>.js` aren't reliably distinguishable by prefix).
    manifest: true,
    rollupOptions: {
      output: {
        // Hashed filenames for cache-busting; per-route code-splitting is
        // achieved by the dynamic imports in `src/app/routes.ts` — Rollup
        // creates a chunk per unique dynamic-import target automatically.
        entryFileNames: 'assets/[name]-[hash].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
});
