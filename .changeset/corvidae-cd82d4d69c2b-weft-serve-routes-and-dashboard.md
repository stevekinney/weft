---
'@lostgradient/weft': minor
---

`serve()` accepts `routes`, Bun's own route table (`ServeRoutes`), and serves those routes on the same origin as Weft's API. A route that would shadow one of Weft's own endpoints makes `serve()` throw before it binds the port. That covers `/api` and `/v1` and anything under them, the root `/mcp` and `/jsonrpc` transports, a root discovery document such as `/openapi.json`, and a pattern such as `/*` or `/:segment` that could match any of those.

Breaking: `serve()` no longer accepts `dashboard` or `dashboardAssets`, and Weft no longer exports `DASHBOARD_PAGE_ROUTES`, `DashboardPageRoute`, `DashboardRouteTarget`, or `DashboardAssets`. To serve a shell of your own, pass it in `routes`.

`dashboard(options)` is new. It takes every `serve()` option plus `distDir`, a built dashboard's directory: `index.html` plus an `assets/` directory. It serves `index.html` at the dashboard's page routes and the files under `assets/` at `/assets/*`, then returns the same `WeftServer` that `serve()` does. It throws before binding when `distDir` has no `index.html`, or when your own `routes` include a route the dashboard registers.
