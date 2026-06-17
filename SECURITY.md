# Security Policy

## Supported Versions

Weft is currently at `0.5.x` (pre-1.0). Security fixes are applied to the latest release only. Once 1.0 ships, this policy will be updated to cover the most recent minor release.

| Version | Supported |
| ------- | --------- |
| 0.5.x   | ✅        |
| < 0.5   | ❌        |

## Scope

Weft ships several attack-surface components that security researchers should be aware of:

- **HTTP server** (`serve()` / `Engine`) — REST and JSON-RPC endpoints, optional authentication, WebSocket upgrade.
- **Storage adapters** — SQLite, LMDB, Turso (libSQL), IndexedDB, browser extension storage, and HTTP-backed remote storage.
- **Worker protocol** — `RemoteWorker` activity/workflow dispatch over HTTP and WebSocket.
- **MCP server** — workflow management operations exposed over Model Context Protocol.
- **CLI** — `weft-mcp` binary in the published package.

## Deployment Security Posture

The built-in server is designed to be explicit about its trust boundary. `serve()` binds to `0.0.0.0:7233` by default, so an open server can be reachable from other hosts on the network. When `auth` is omitted, the default `unauthenticatedAccess: 'warn'` starts the server and logs a warning for local development; it does not fail closed.

Production deployments should configure `auth` and set `unauthenticatedAccess: 'reject'`, or set `WEFT_SERVER_AUTHENTICATION_REQUIRED=1`, so startup fails before binding when authentication is missing. Weft does not terminate TLS itself; run it behind a TLS-terminating reverse proxy, ingress, or platform load balancer when traffic leaves a trusted local boundary.

An unauthenticated open server exposes every REST, JSON-RPC, WebSocket, and MCP operation that the process enables, including mutating workflow operations such as cancellation, termination, bulk deletion, storage administration routes, and MCP workflow-control tools. Treat an intentionally open server as an administrative local process boundary, not as an internet-facing endpoint.

Out-of-scope:

- Vulnerabilities in underlying dependencies (report those directly to the upstream project).
- Issues that only reproduce with explicitly malicious `Engine` configuration (e.g., an operator who knowingly points `HTTPStorage` at an attacker-controlled server).
- Theoretical or speculative findings without a concrete reproduction path.

## Reporting a Vulnerability

**Please do not file a public GitHub issue for security vulnerabilities.**

Email: **hello@stevekinney.net**

Alternatively, you can [open a private security advisory on GitHub](https://github.com/stevekinney/weft/security/advisories/new) — GitHub routes the report to the maintainer without exposing your contact details publicly.

Include in your report:

1. A clear description of the vulnerability and the affected component.
2. Steps to reproduce — the more concrete, the faster the response.
3. The potential impact (e.g., arbitrary code execution, data exfiltration, authentication bypass, denial of service).
4. Whether you have a proof-of-concept or exploit code (attach it or include a private Gist link).

You will receive an acknowledgement within **72 hours** and a status update within **7 days**. If you do not hear back, follow up at the same address — emails occasionally land in spam.

## Disclosure Policy

Weft follows coordinated disclosure:

1. The vulnerability is confirmed and a fix is developed privately.
2. A patched release is published.
3. A security advisory is filed on GitHub and the CVE is requested (if applicable) **after** the fix is available.

We ask that reporters keep the vulnerability confidential until the fix is published. We commit to a **14-day** target from confirmation to patched release for critical issues. For lower-severity findings, the timeline may extend to 30 days.

If a 90-day hard deadline has passed without resolution, disclosure is at the researcher's discretion.

## Credit

Security researchers who responsibly disclose vulnerabilities will be credited in the release notes and the GitHub security advisory (unless they prefer to remain anonymous).
