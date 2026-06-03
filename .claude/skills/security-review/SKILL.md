---
name: security-review
description: >-
  Security review checklist for weft covering server routes, MCP
  authentication, workflow trust boundaries, storage, activity isolation,
  and credential handling. Use when the user says "security review",
  "check for vulnerabilities", "audit security", "review trust
  boundaries", or when changes touch server routes, authentication,
  storage, or any code that handles untrusted input. Also use proactively
  when implementing features that cross trust boundaries.
---

# Security Review

Checklist for reviewing security-sensitive changes in the weft durable execution engine. Focus on trust boundaries — where user input, external data, or untrusted workflow code meets the engine.

## When to Activate

- Adding or modifying server routes (`src/server/handler.ts`, `src/server/operations/**`, `src/server/handler/**`)
- Changing MCP discovery, authentication, sessions, tools, or resources (`src/mcp/**`, `src/server/mcp-discovery.ts`)
- Modifying workflow execution, checkpoint replay, or activity dispatch (`src/core/`)
- Changing storage backends or serialization (`src/storage/`, `src/core/codec.ts`)
- Adding new public API surface (`src/index.ts`)
- Handling environment variables or secrets (`src/environment.ts`)

## Checklist

### 1. Server Route Validation

**File**: `src/server/handler.ts`

The server routes through operation handlers plus transport-specific discovery endpoints. For each route that accepts input:

- [ ] Path parameters are decoded safely (`decodeURIComponent` is already used — verify no double-decoding)
- [ ] Request bodies are parsed with try/catch (malformed JSON returns 400, not 500)
- [ ] Query parameters (`status`, `type`, `failure_category`, date ranges, `limit`, `offset`) are validated before use — check for NaN on numeric params, validate enum values against allowed sets
- [ ] No user-controlled strings are interpolated into storage keys without sanitization
- [ ] Error messages do not leak internal state (stack traces, storage keys, file paths)
- [ ] Discovery documents that emit absolute URLs use `publicOrigin` or trusted host validation, not arbitrary Host-header text
- [ ] REST `EngineFailure` responses use the canonical masked body; raw engine messages stay out of HTTP responses
- [ ] Schedule routes use operation-catalog access policies consistently across REST and JSON-RPC; do not add tenant-claim gates back into core schedule access
- [ ] Async activity completion routes keep tokens in the body, not the path; treat tokens as deterministic identifiers rather than secrets; require payload validation and `serve({ auth })` guidance when exposed outside a trusted boundary

Routes that accept bodies include workflow start, signal, update, query, attributes, review decisions, bulk actions, JSON-RPC, HTTP storage, and MCP `POST /mcp`.
Async activity completion (`POST /api/v1/activities/complete` and `/fail`) also accepts bodies and must return 400 for malformed JSON.

### 2. MCP Authentication

**Files**: `src/mcp/**`, `src/server/runtime/authentication-bridge.ts`, `src/server/mcp-discovery.ts`

- [ ] Bearer tokens, startup tokens, API keys, and authenticated principals are never logged, serialized to checkpoints, or included in error messages
- [ ] `initialize` binds the authenticated principal to the MCP session, and subsequent POST/GET/DELETE requests cannot switch principals by changing headers
- [ ] MCP sessions keep authenticated principals bound for the session lifetime; route authorization is scope-based, not tenant-claim-based
- [ ] Local stdio admission requires `--startup-token` or an explicit trusted-boundary flag
- [ ] Workflow tool failures return MCP tool results with `isError: true` without leaking server internals

### 3. Workflow Trust Boundary

**Files**: `src/core/engine.ts`, `src/core/context.ts`, `src/core/checkpoint.ts`

User-defined workflow functions run inside the engine. They should not be able to:

- [ ] Access engine internals or other workflows' state
- [ ] Corrupt checkpoint data (verify checkpoint writes are atomic)
- [ ] Inject arbitrary data that gets `eval()`'d or `new Function()`'d on replay
- [ ] Cause unbounded memory growth through oversized checkpoint payloads
- [ ] Escape the workflow context to access the underlying storage directly

### 4. Storage and Serialization

**Files**: `src/storage/bun-sql.ts`, `src/storage/memory.ts`, `src/core/codec.ts`

- [ ] `BunSQLiteStorage` uses parameterized queries — no string concatenation for SQL
- [ ] The `encode()`/`decode()` codec (msgpack) does not execute code during deserialization
- [ ] Storage keys constructed from user input (workflow IDs, attribute names) are bounded in length and character set
- [ ] Bounded range deletes go through `storageDeleteRange()` or the same normalized bounds; unbounded deletion must use explicit `deletePrefix()`, never a malformed `deleteRange()`
- [ ] Bounded delete tests cover empty options rejection, invalid negative limits, impossible bound intersections, and scoped-storage prefix-smuggling attempts
- [ ] Batch operations in storage cannot be used to overwrite keys belonging to other workflows
- [ ] IndexedDB storage (`src/storage/indexeddb.ts`) applies the same key validation

### 5. Activity Isolation

**Files**: `src/workers/activity-runner.ts`, `src/core/activities.ts`

- [ ] Activity timeouts are enforced — a hung activity cannot block the engine indefinitely
- [ ] Activity results are bounded in size before being written to checkpoints
- [ ] Failed activities do not leak internal engine state in their error messages
- [ ] Worker pool exhaustion is handled gracefully (backpressure, not crash)

### 6. Input Validation at API Boundaries

- [ ] Public-facing functions validate inputs with Zod or explicit type guards (following the `src/environment.ts` pattern)
- [ ] No `any` types at trust boundaries: server routes, storage interface methods, public API exports
- [ ] Duration strings passed to `parseDuration()` are validated (reject nonsensical values like negative durations)
- [ ] Workflow IDs and signal/update names are validated for length and character set

### 7. Credential and Secret Handling

**File**: `src/environment.ts`

- [ ] Environment variables accessed via `Bun.env` and validated through Zod schemas
- [ ] Secrets are not included in: log output, error messages, checkpoint data, HTTP responses, metrics
- [ ] `.env` files are in `.gitignore`
- [ ] No hardcoded credentials, tokens, or API keys in source code

## How to Use This Checklist

For a focused review, check only the sections relevant to the changed files. For a comprehensive audit, work through all seven sections. Mark items as verified and note any findings that need follow-up.
