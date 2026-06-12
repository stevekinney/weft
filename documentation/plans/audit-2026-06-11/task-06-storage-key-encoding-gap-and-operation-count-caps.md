# Task 06: Storage key encoding gap and operation-count caps

**Severity:** high

## Signal storage key embeds unencoded signal name — colon in name causes prefix-scan aliasing and destructive consumeSignal cross-match

- **Severity:** high (durability)
- **Files:** `src/storage/interface.ts`, `src/core/engine/signals.ts`

**Evidence:** interface.ts:439-440: KEYS.signal embeds raw name without encodeStorageKeyComponent. A signal named 'order:placed' produces key sig:<wfid>:order:placed:<encoded_id>. consumeSignal/hasBufferedSignal/peekSignal all build the prefix sig:<wfid>:<rawSignalName>: — a workflow parked on waitForSignal('order') can consume a signal delivered under name 'order:placed' because the prefix matches. consumeSignal destructively deletes the matched key. KEYS.signalAcceptedResponse at line 444-445 correctly encodes name — the inconsistency is an oversight.

**Required fix:** Change KEYS.signal at line 440 to use encodeStorageKeyComponent(name) consistent with KEYS.signalAcceptedResponse. Update the three scan-prefix constructions in signals.ts (lines 303, 316, 337) to use encodeStorageKeyComponent(signalName). Add a test verifying that a signal name containing ':' round-trips without key aliasing. This is a storage key format change requiring a schema version note.

## Storage batch and conditional-batch have no operation-count cap

- **Severity:** medium (security)
- **Files:** `src/server/operations/storage.ts`

**Evidence:** storageBatchInput at line 72 and storageConditionalBatchInput at lines 74-77 have no .max() on their arrays. An authenticated storage:admin caller can submit tens of thousands of batch operations in one request. Storage batch endpoints use HTTP-only REST bindings (jsonRpcHttp: false) so the 1 MB JSON-RPC body cap does not apply.

**Required fix:** Add .max(MAX_BATCH_OPERATIONS) (e.g. 1000) to both operations and conditions arrays. Also add .max(MAX_SCAN_LIMIT) (e.g. 10,000) to the limit field in storageScanInput. Document the caps in configuration.md and surface in the OpenRPC schema.

## WebExtensionStorage claims atomicBatch: true but batch() is only in-process-serialized, not cross-context atomic

- **Severity:** high (durability)
- **Files:** `src/storage/web-extension.ts`

**Evidence:** web-extension.ts:280: capabilities() returns atomicBatch: true. The #withMutationLock at lines 327-346 is a process-local Promise queue — two extension contexts (background + content script) sharing chrome.storage.local both call #getKeyspace(), apply edits in memory, then call #writeKeyspace(), silently overwriting each other. browser.storage.set() is not a transaction. The inline comment at lines 273-275 even acknowledges 'no native CAS and scans are best-effort across extension contexts' yet still returns atomicBatch: true.

**Required fix:** Downgrade atomicBatch to false in WebExtensionStorage.capabilities(). Update the storage.md table to show atomicBatch as 'no (same context only)' for WebExtensionStorage, and add a prominent warning in the adapter section that multi-context deployments cannot rely on atomic batch semantics.
