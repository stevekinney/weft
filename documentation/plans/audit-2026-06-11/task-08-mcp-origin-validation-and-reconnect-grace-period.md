# Task 08: MCP origin validation and reconnect grace period

**Severity:** medium

## MCP origin validation falls back to Host-header-derived origin when publicOrigin and trustedHosts are absent

- **Severity:** medium (security)
- **Files:** `src/mcp/http.ts`, `src/server/handler/route-dispatch.ts`

**Evidence:** mcp/http.ts:374: third branch of validateOrigin is originUrl.host === new URL(request.url).host. Bun's request.url is derived from the Host header. When neither publicOrigin nor trustedHosts is configured, an attacker who controls both Host: and Origin: headers can make this evaluate to true for any origin, bypassing the MCP CORS check. resolveDiscoveryOrigin in route-dispatch.ts already returns 503 in this case — the /mcp endpoint bypasses that guard.

**Required fix:** When neither publicOrigin nor trustedHosts is set, reject all cross-origin MCP requests outright (return 403) rather than falling back to Host-derived comparison. Add a startup warning alongside the existing auth posture warning when MCP is enabled without publicOrigin or trustedHosts configured.

## 100ms default reconnect grace window causes unnecessary task requeues in cloud environments

- **Severity:** medium (durability)
- **Files:** `src/server/serve-internals.ts`, `src/server/runtime/authentication-bridge.ts`

**Evidence:** serve-internals.ts:48: DEFAULT_WORKER_RECONNECT_GRACE_PERIOD_MS = 100. Cloud rolling updates (ECS, Kubernetes, Cloud Run) typically take 1-30s to reconnect. With 100ms grace, every rolling-update triggers runWorkerDisconnectRequeue which calls reassignOrExpireTask with reason 'worker-disconnect', incrementing requeueCount and attempt, and starting backoff delay. Protocol doc does not caution that 100ms is for local/embedded contexts only.

**Required fix:** Raise the default to 2000ms. Update documentation and JSDoc to explicitly call out that 100ms is designed for test/embedded scenarios and production cloud deployments should set workerReconnectGracePeriodMs to at least 5000ms. Optionally add a log warning when the grace period fires on a task with low attempt counts.
