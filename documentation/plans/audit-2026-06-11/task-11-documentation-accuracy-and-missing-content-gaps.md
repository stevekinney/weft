# Task 11: Documentation accuracy and missing-content gaps

**Severity:** medium

## ctx.log documentation uses 'replay' framing contradicting checkpoint-not-replay architecture

- **Severity:** medium (documentation)
- **Files:** `documentation/reference/api-context.md`, `documentation/architecture/checkpoint-versus-replay.md`

**Evidence:** api-context.md:509 states 'A workflow body re-executes from the start on recovery to rebuild state (replay)' — describing Temporal's model, not Weft's. The actual suppression mechanism: logs are suppressed when the current stepIndex has a cached result in accumulatedResults (step loaded from checkpoint). The term 'replay' also appears at lines 65, 206, 581, 591 as shorthand for cache-hit during recovery.

**Required fix:** Rewrite the ctx.log suppression description to accurately describe the mechanism: logs are suppressed at steps whose results were loaded from the checkpoint. Replace 'replay' framing throughout api-context.md with 'checkpoint cache-hit' or 'restored from checkpoint' language.

## configuration.md env vars table is missing WEFT_ADDR, WEFT_PROFILE, WEFT_HOME, WEFT_DEV_WARNINGS, and mischaracterizes WEFT_TOKEN

- **Severity:** medium (documentation)
- **Files:** `documentation/reference/configuration.md`, `src/connection.ts`, `src/core/engine/construction.ts`

**Evidence:** src/connection.ts lines 192, 228, 241, 245, 353 reads WEFT_ADDR, WEFT_PROFILE, WEFT_HOME — used by all CLI commands and HttpClient, not documented. src/core/engine/construction.ts:128 reads WEFT_DEV_WARNINGS — undocumented. Existing WEFT_TOKEN entry says 'weft codegen --server fallback' but connection.ts:149 shows it is used by ALL client connections.

**Required fix:** Add WEFT_ADDR, WEFT_PROFILE, WEFT_HOME, WEFT_DEV_WARNINGS to the env vars table with accurate descriptions. Correct the WEFT_TOKEN description to reflect its use by all client connections, not only codegen.

## configuration.md and api-server.md ServeOptions tables omit cors and rateLimit fields

- **Severity:** medium (documentation)
- **Files:** `documentation/reference/configuration.md`, `documentation/reference/api-server.md`

**Evidence:** src/server/index.ts lines 197-213: ServeOptions includes rateLimit?: RateLimitConfig and cors?: CorsOptions. Both reference pages list 10+ options but omit these two. cors is security-relevant; its absence from the reference means an operator securing a CORS deployment has no single authoritative reference point. Both fields ARE in guides/server.md.

**Required fix:** Add cors and rateLimit to the ServeOptions interface block and table in both configuration.md and api-server.md, with type names and a cross-reference to guides/server.md for full documentation.

## ctx.saga() and forks advertised in README but have no user-facing documentation

- **Severity:** medium (documentation)
- **Files:** `README.md`, `src/core/context/saga.ts`, `documentation/guides/workflows.md`

**Evidence:** README.md line 139 lists 'sagas via ctx.saga()' and 'forks' as features. ctx.saga() does not appear in workflows.md or api-context.md (grep confirms zero hits). It exists as source (saga.ts) and has tests but no doc page. engine.fork() appears as a bare table row in api-server.md with no conceptual explanation.

**Required fix:** Add a ctx.saga() section to documentation/guides/workflows.md documenting the step format, compensation model, and failure behavior. Add a fork section explaining engine.fork() semantics. Alternatively, remove the feature bullets from README until guides exist — option A strongly preferred.

## No-replay pitch omits critical constraint: yield* call order must be stable between deployments

- **Severity:** medium (documentation)
- **Files:** `README.md`, `documentation/getting-started/hello-world.md`, `documentation/guides/workflows.md`

**Evidence:** README, hello-world.md, and checkpoint-versus-replay.md say 'the only rule is yield* for durable operations' and 'your code can use Date.now(), Math.random(), anything.' They omit that the ORDER of yield* calls between checkpoints must be stable across deployments — adding a ctx.sleep before an existing ctx.run in a deployed workflow produces VersionMismatchError or silent slot mismatch. recovery-and-deploys.md mentions this obliquely in the stub-handlers context but no document consolidates all 'you must not change mid-flight' rules.

**Required fix:** Add a 'What you cannot change mid-flight' section to the workflows guide covering: (1) order of yield* operations before the current checkpoint position is immutable without a version bump; (2) checkpoint locals must remain structurally cloneable; (3) activity names in .activities({}) are durable identity keys — renaming is a breaking change for in-flight runs.

## SECURITY.md version table is stale (says 0.1.x, package is at 0.3.0) and contains no deployment hardening guidance

- **Severity:** medium (documentation)
- **Files:** `SECURITY.md`, `package.json`

**Evidence:** SECURITY.md lines 5-10: '| 0.1.x | ✅ |' and 'Weft is currently at 0.1.x (pre-1.0)'. package.json shows version 0.3.0. SECURITY.md lists attack surfaces but contains no TLS guidance, no reverse-proxy guidance, no authentication-default explanation, and no statement of what an operator must do before network exposure.

**Required fix:** Update the version table to 0.3.x. Add a Deployment Security Posture section covering: (1) auth default is 'warn' meaning server runs open — production must configure auth and set unauthenticatedAccess:'reject'; (2) Weft does not terminate TLS — use a reverse proxy; (3) default port 0.0.0.0:7233 is reachable from all interfaces; (4) what an open server exposes (workflow termination, bulk delete, all operations).

## weft.authenticate stdio frame format is undocumented — agents cannot implement startup-token auth without reading source

- **Severity:** medium (documentation)
- **Files:** `src/mcp/stdio.ts`, `documentation/getting-started/transports.md`, `documentation/reference/api-server.md`

**Evidence:** transports.md line 109 says 'send weft.authenticate as the first frame' but provides no JSON structure. The frame must be {"jsonrpc":"2.0","id":1,"method":"weft.authenticate","params":{"token":"<value>"}}. The error code for mismatch is -32010, exit codes are 0 (clean), 1 (unexpected error), 2 (auth failure). Only source of truth is src/mcp/stdio.ts and the test suite.

**Required fix:** Add a fenced code block to transports.md showing the exact weft.authenticate frame JSON, the expected success response shape, the error code for mismatch (-32010), and all three exit codes (0/1/2). Mirror in api-server.md#mcp-server.

## Engine extends untyped EventTarget — opening events.md example does not typecheck, guide recommends double-cast

- **Severity:** medium (dx)
- **Files:** `src/core/engine/index.ts`, `src/core/events/event-map.ts`, `documentation/guides/events.md`

**Evidence:** Engine extends EventTarget (index.ts:356) without implementing TypedEventTarget<WeftEventMap>. events.md line 76 shows engine as unknown as TypedEventTarget<WeftEventMap> — the double-cast CLAUDE.md conventions flag as a red flag. The opening events.md example (lines 10-12) accesses event.workflowId and event.duration on a plain Event parameter — does not typecheck.

**Required fix:** Have Engine implement TypedEventTarget<WeftEventMap> by declaring typed addEventListener/removeEventListener overloads inline on the class (approx. 10 lines). This eliminates the double-cast, makes the opening events.md example typecheck, and removes the as DevelopmentWarningEvent cast from all JSDoc examples.

## Omitting resolveWorkflowServices silently yields ctx.services === undefined on recovery with no warning emitted

- **Severity:** medium (dx)
- **Files:** `src/core/engine/lifecycle/recovered-services.ts`, `documentation/guides/workflows.md`

**Evidence:** recovered-services.ts:47-50: when resolver is null, the function returns false before checking the workflowHasServices marker. A workflow started with services: { db } that recovers without resolveWorkflowServices proceeds with ctx.services === undefined — silently. No event, no log, no diagnostic. The guide says to configure resolveWorkflowServices but does not warn what happens if you don't.

**Required fix:** In reprovideRecoveredServices, when !resolver and the workflowHasServices storage marker is present, emit a DevelopmentWarningEvent (or log warning) naming the workflow and explaining that ctx.services will be undefined. Add a warning callout to the services section of workflows.md.

## MCP tools/list returns listChanged: false permanently — agents miss dynamically registered workflows

- **Severity:** medium (dx)
- **Files:** `src/mcp/dispatcher.ts`, `src/mcp/tools.ts`

**Evidence:** dispatcher.ts:151 hardcodes tools: { listChanged: false }. No notifications/tools/list_changed message is ever sent. The WeakMap cache in tools.ts invalidates on definition changes so tools/list returns fresh data on explicit call, but clients trusting listChanged: false per MCP spec will cache stale tool lists. engine.register() is a supported public API callable post-startup.

**Required fix:** Either hook engine.register() events to push notifications/tools/list_changed and flip capability to listChanged: true, or document the limitation explicitly in api-server.md so agents know to call tools/list on each session rather than caching.

## LMDBStorage comment implies adapter resets read transaction but it relies on undocumented lmdb-js auto-reset

- **Severity:** low (durability)
- **Files:** `src/storage/lmdb.ts`

**Evidence:** lmdb.ts:21-22: 'The adapter resets lmdb-js's cached read transaction after every write.' But no resetReadTxn() call exists in the adapter. The reset is done automatically by lmdb-js after each write commit. If this behavior is made opt-in in a future lmdb-js version, the adapter would silently degrade to stale reads.

**Required fix:** Correct the comment to accurately state that the linearizable guarantee comes from lmdb-js automatically calling resetReadTxn() after each commit, not from explicit adapter action. Note the lmdb-js version range known to provide this guarantee.

## pendingSignals checkpoint field is always empty — misleading dead field in schema

- **Severity:** low (dx)
- **Files:** `src/core/types/checkpoint.ts`, `src/core/checkpoint/lifecycle.ts`

**Evidence:** checkpoint.ts:114: pendingSignals: string[] field. lifecycle.ts:28 initializes as [], lifecycle.ts:69 carries forward unchanged. No production code ever writes a non-empty value. The field name implies signals are stored in checkpoints (which would solve the crash-loss problem), but they are not — signals are separate sig: keys. architecture/research.md:16 names pendingSignals as a captured value implying design intent that was never implemented.

**Required fix:** Either remove the field (schema version bump) and add a comment explaining signals are stored as separate storage keys, or populate it with the signal names the workflow is currently waiting on for observability. If deferred, add a comment to the type definition explaining the field is reserved and never populated.

## AGENTS.md references non-existent src/types.ts, has contradictory types instructions, and uses stale template language

- **Severity:** medium (dx)
- **Files:** `AGENTS.md`

**Evidence:** AGENTS.md line 3 says 'Codex (Codex.ai/code)' not general agents. Line 106 calls repo 'This template' claiming it avoids custom error classes — Weft exports WeftError, ActivityResolutionError, and dozens. Line 125 says 'There is no shared src/types.ts' but line 164 instructs to 'put shared/reusable types in src/types.ts'. The actual type system is src/core/types/ (40+ files). An agent following this creates a new file at the wrong path.

**Required fix:** Fix line 3 to 'coding agents' generally. Remove 'template' language and false claim about avoiding custom errors. Replace line 164 types instruction to say 'Domain-specific and shared types live under src/core/types/ near their modules; there is no top-level src/types.ts.'
