# Task 07: Worker result payload size and API key timing side-channel

**Severity:** high

## RemoteWorker taskResult value persisted to storage without payload-size check

- **Severity:** high (security)
- **Files:** `src/server/runtime/websocket-worker.ts`, `src/server/task-state.ts`

**Evidence:** onTaskResultMessage (websocket-worker.ts:247-265) accepts CompletedTaskResultMessage whose value is any RemoteWorkerJsonValue, structurally validated but NOT size-bounded. It calls transitionInflightToResolved which persists to storage. Every other completion path calls assertPayloadWithinLimit: completeAsyncActivity (async-activity-completion.ts:336), inline activity path (operations-activity.ts:408), reconciliation (activity-reconciliation.ts:156). The WebSocket path is the sole exception. No Bun-level websocket.maxPayload is set.

**Required fix:** Add assertPayloadWithinLimit(message.value, ...) in onTaskResultMessage (and for the error string in failed/cancelled variants) before calling transitionInflightToResolved. Thread the engine's payloadSizePolicy.maxBytes through ServeOptions or ServerContext so the WebSocket handler can access it.

## Non-constant-time API key comparison via Set.has() enables timing side-channel

- **Severity:** medium (security)
- **Files:** `src/server/authentication/api-key.ts`, `src/server/authentication/index.ts`

**Evidence:** api-key.ts:120: if (apiKeySet?.has(presentedKey)). JavaScript Set.has() is not constant-time. The rotating-api-key-store.ts path also uses Map.get() for the same comparison. An attacker making repeated requests can use response-time variance to shrink the brute-force search space.

**Required fix:** Replace Set.has(presentedKey) with a constant-time comparison loop using node:crypto timingSafeEqual over the key bytes, iterating all known keys and XOR-accumulating the result so early-exit is impossible. Apply the same fix to the rotating-api-key-store.ts Map.get() path.
