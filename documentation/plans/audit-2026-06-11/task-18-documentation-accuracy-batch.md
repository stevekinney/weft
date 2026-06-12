# Task 18: Documentation accuracy batch (docs-only)

**Severity:** medium

## Finding: ctx.log documentation uses 'replay' framing contradicting checkpoint-not-replay architecture

- **Severity:** medium (documentation)
- **Files (audit snapshot):** `documentation/reference/api-context.md`, `documentation/architecture/checkpoint-versus-replay.md`

### Evidence

api-context.md:509 states 'A workflow body re-executes from the start on recovery to rebuild state (replay)' — describing Temporal's model, not Weft's. The actual suppression mechanism: logs are suppressed when the current stepIndex has a cached result in accumulatedResults (step loaded from checkpoint). The term 'replay' also appears at lines 65, 206, 581, 591 as shorthand for cache-hit during recovery.

### Required fix

Rewrite the ctx.log suppression description to accurately describe the mechanism: logs are suppressed at steps whose results were loaded from the checkpoint. Replace 'replay' framing throughout api-context.md with 'checkpoint cache-hit' or 'restored from checkpoint' language.

## Finding: configuration.md env vars table is missing WEFT_ADDR, WEFT_PROFILE, WEFT_HOME, WEFT_DEV_WARNINGS, and mischaracterizes WEFT_TOKEN

- **Severity:** medium (documentation)
- **Files (audit snapshot):** `documentation/reference/configuration.md`, `src/connection.ts`, `src/core/engine/construction.ts`

### Evidence

src/connection.ts lines 192, 228, 241, 245, 353 reads WEFT_ADDR, WEFT_PROFILE, WEFT_HOME — used by all CLI commands and HttpClient, not documented. src/core/engine/construction.ts:128 reads WEFT_DEV_WARNINGS — undocumented. Existing WEFT_TOKEN entry says 'weft codegen --server fallback' but connection.ts:149 shows it is used by ALL client connections.

### Required fix

Add WEFT_ADDR, WEFT_PROFILE, WEFT_HOME, WEFT_DEV_WARNINGS to the env vars table with accurate descriptions. Correct the WEFT_TOKEN description to reflect its use by all client connections, not only codegen.

## Finding: configuration.md and api-server.md ServeOptions tables omit cors and rateLimit fields

- **Severity:** medium (documentation)
- **Files (audit snapshot):** `documentation/reference/configuration.md`, `documentation/reference/api-server.md`

### Evidence

src/server/index.ts lines 197-213: ServeOptions includes rateLimit?: RateLimitConfig and cors?: CorsOptions. Both reference pages list 10+ options but omit these two. cors is security-relevant; its absence from the reference means an operator securing a CORS deployment has no single authoritative reference point. Both fields ARE in guides/server.md.

### Required fix

Add cors and rateLimit to the ServeOptions interface block and table in both configuration.md and api-server.md, with type names and a cross-reference to guides/server.md for full documentation.

## Finding: ctx.saga() and forks advertised in README but have no user-facing documentation

- **Severity:** medium (documentation)
- **Files (audit snapshot):** `README.md`, `src/core/context/saga.ts`, `documentation/guides/workflows.md`

### Evidence

README.md line 139 lists 'sagas via ctx.saga()' and 'forks' as features. ctx.saga() does not appear in workflows.md or api-context.md (grep confirms zero hits). It exists as source (saga.ts) and has tests but no doc page. engine.fork() appears as a bare table row in api-server.md with no conceptual explanation.

### Required fix

Add a ctx.saga() section to documentation/guides/workflows.md documenting the step format, compensation model, and failure behavior. Add a fork section explaining engine.fork() semantics. Alternatively, remove the feature bullets from README until guides exist — option A strongly preferred.

## Finding: No-replay pitch omits critical constraint: yield\* call order must be stable between deployments

- **Severity:** medium (documentation)
- **Files (audit snapshot):** `README.md`, `documentation/getting-started/hello-world.md`, `documentation/guides/workflows.md`

### Evidence

README, hello-world.md, and checkpoint-versus-replay.md say 'the only rule is yield* for durable operations' and 'your code can use Date.now(), Math.random(), anything.' They omit that the ORDER of yield* calls between checkpoints must be stable across deployments — adding a ctx.sleep before an existing ctx.run in a deployed workflow produces VersionMismatchError or silent slot mismatch. recovery-and-deploys.md mentions this obliquely in the stub-handlers context but no document consolidates all 'you must not change mid-flight' rules.

### Required fix

Add a 'What you cannot change mid-flight' section to the workflows guide covering: (1) order of yield\* operations before the current checkpoint position is immutable without a version bump; (2) checkpoint locals must remain structurally cloneable; (3) activity names in .activities({}) are durable identity keys — renaming is a breaking change for in-flight runs.

## Finding: SECURITY.md version table is stale (says 0.1.x, package is at 0.3.0) and contains no deployment hardening guidance

- **Severity:** medium (documentation)
- **Files (audit snapshot):** `SECURITY.md`, `package.json`

### Evidence

SECURITY.md lines 5-10: '| 0.1.x | ✅ |' and 'Weft is currently at 0.1.x (pre-1.0)'. package.json shows version 0.3.0. SECURITY.md lists attack surfaces but contains no TLS guidance, no reverse-proxy guidance, no authentication-default explanation, and no statement of what an operator must do before network exposure.

### Required fix

Update the version table to 0.3.x. Add a Deployment Security Posture section covering: (1) auth default is 'warn' meaning server runs open — production must configure auth and set unauthenticatedAccess:'reject'; (2) Weft does not terminate TLS — use a reverse proxy; (3) default port 0.0.0.0:7233 is reachable from all interfaces; (4) what an open server exposes (workflow termination, bulk delete, all operations).

## Finding: weft.authenticate stdio frame format is undocumented — agents cannot implement startup-token auth without reading source

- **Severity:** medium (documentation)
- **Files (audit snapshot):** `src/mcp/stdio.ts`, `documentation/getting-started/transports.md`, `documentation/reference/api-server.md`

### Evidence

transports.md line 109 says 'send weft.authenticate as the first frame' but provides no JSON structure. The frame must be {"jsonrpc":"2.0","id":1,"method":"weft.authenticate","params":{"token":"<value>"}}. The error code for mismatch is -32010, exit codes are 0 (clean), 1 (unexpected error), 2 (auth failure). Only source of truth is src/mcp/stdio.ts and the test suite.

### Required fix

Add a fenced code block to transports.md showing the exact weft.authenticate frame JSON, the expected success response shape, the error code for mismatch (-32010), and all three exit codes (0/1/2). Mirror in api-server.md#mcp-server.

## Finding: LMDBStorage comment implies adapter resets read transaction but it relies on undocumented lmdb-js auto-reset

- **Severity:** low (durability)
- **Files (audit snapshot):** `src/storage/lmdb.ts`

### Evidence

lmdb.ts:21-22: 'The adapter resets lmdb-js's cached read transaction after every write.' But no resetReadTxn() call exists in the adapter. The reset is done automatically by lmdb-js after each write commit. If this behavior is made opt-in in a future lmdb-js version, the adapter would silently degrade to stale reads.

### Required fix

Correct the comment to accurately state that the linearizable guarantee comes from lmdb-js automatically calling resetReadTxn() after each commit, not from explicit adapter action. Note the lmdb-js version range known to provide this guarantee.

## Finding: AGENTS.md references non-existent src/types.ts, has contradictory types instructions, and uses stale template language

- **Severity:** medium (dx)
- **Files (audit snapshot):** `AGENTS.md`

### Evidence

AGENTS.md line 3 says 'Codex (Codex.ai/code)' not general agents. Line 106 calls repo 'This template' claiming it avoids custom error classes — Weft exports WeftError, ActivityResolutionError, and dozens. Line 125 says 'There is no shared src/types.ts' but line 164 instructs to 'put shared/reusable types in src/types.ts'. The actual type system is src/core/types/ (40+ files). An agent following this creates a new file at the wrong path.

### Required fix

Fix line 3 to 'coding agents' generally. Remove 'template' language and false claim about avoiding custom errors. Replace line 164 types instruction to say 'Domain-specific and shared types live under src/core/types/ near their modules; there is no top-level src/types.ts.'

## Scope note

This task is documentation-and-comments only — no behavioral code changes. Each finding above is an independent correction; all are required. The SECURITY.md item includes adding a deployment-hardening section (what to put in front of a Weft server before exposing it: reverse proxy, auth, network posture) — state the known public-mutator auth posture honestly rather than papering over it.

## Acceptance criteria (all required — completion is binary)

- [ ] Every finding above is corrected; `bun run verify:documentation` and `bun run verify:markdown-doctests` pass.
- [ ] SECURITY.md supported-versions table matches the current release line and a deployment-hardening/threat-model section exists.
- [ ] AGENTS.md contains no references to files that do not exist and no self-contradictory type guidance.

## Standard execution requirements

- Line numbers and file paths in the evidence are from the 2026-06-11 audit snapshot and may have drifted. Re-locate every cited site by symbol or function name before editing. If current code differs from the evidence, update the plan to match reality — the invariant being fixed is the requirement, not the line numbers. If the described behavior no longer exists at all, stop and report that instead of forcing a change.
- TDD: every behavioral fix needs a regression test that fails before the fix and passes after. Documentation-only tasks need no new tests but must keep existing doctests green.
- Verification — all of these must pass before the task is complete: `bun run format:check`, `bun run lint`, `bun run typecheck`, `bun test --parallel`. For documentation changes also run `bun run verify:documentation` (plus `bun run verify:markdown-doctests` when Markdown examples change). For changes to exported types or the package surface also run `bun run build` and `bun run verify:jsdoc:full`.
- Completion is binary: every acceptance criterion met and the full suite green. If a criterion cannot be met, stop and report the blocker — do not ship a partial, do not weaken a gate, do not defer silently.
