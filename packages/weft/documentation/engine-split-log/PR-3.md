# PR 3: Core helper module split

Seven oversized core helper files are now thin barrel re-exports over
domain-focused modules in directory-based entrypoints. Existing imports from the
original `src/core/*.ts` paths continue to work unchanged while the resolved
max-lines suppressions are removed from the oxlint disable inventory.

## Domain files

| File                                             | Moved code                                                       |
| ------------------------------------------------ | ---------------------------------------------------------------- |
| `src/core/scheduler/duration.ts`                 | Duration parsing, storage timestamp normalization, retry backoff |
| `src/core/scheduler/timer-sources.ts`            | Timer scan source types and timer iterator helpers               |
| `src/core/scheduler/timer-batch.ts`              | Timer entry validation and timer batch operation creation        |
| `src/core/scheduler/scheduler-class.ts`          | `SchedulerOptions` and `Scheduler`                               |
| `src/core/schedule/cron-types.ts`                | Cron parser and occurrence helper types                          |
| `src/core/schedule/cron-parser.ts`               | Cron field parsing and expression parsing                        |
| `src/core/schedule/cron-formatter.ts`            | Time zone formatting and local date-time helpers                 |
| `src/core/schedule/cron-occurrence.ts`           | Next and due cron occurrence calculation                         |
| `src/core/checkpoint/interfaces.ts`              | Checkpoint validation result and divergence interfaces           |
| `src/core/checkpoint/serialization.ts`           | Checkpoint serialization and deserialization                     |
| `src/core/checkpoint/lifecycle.ts`               | Checkpoint creation, advancement, and size calculation           |
| `src/core/checkpoint/validation.ts`              | Round-trip and shape validation                                  |
| `src/core/checkpoint/comparison.ts`              | Checkpoint divergence comparison helpers                         |
| `src/core/codec/extension-codec.ts`              | Shared MessagePack extension codec registrations                 |
| `src/core/codec/api.ts`                          | Public `encode` and `decode` helpers                             |
| `src/core/codec/validation.ts`                   | Cloneability validation                                          |
| `src/core/events/workflow-events.ts`             | Workflow lifecycle event classes                                 |
| `src/core/events/activity-events.ts`             | Activity lifecycle event classes                                 |
| `src/core/events/agent-events.ts`                | Agent token event class                                          |
| `src/core/events/signal-events.ts`               | Signal event classes                                             |
| `src/core/events/attribute-events.ts`            | Search attribute change event class                              |
| `src/core/events/update-events.ts`               | Workflow update event classes                                    |
| `src/core/events/system-events.ts`               | Warning, storage, alert, and constraint event classes            |
| `src/core/events/event-map.ts`                   | `WeftEventMap` and `TypedEventTarget`                            |
| `src/core/interceptor/interception-contexts.ts`  | Workflow and activity interception context types                 |
| `src/core/interceptor/interceptor-interfaces.ts` | Interceptor and composed interceptor interfaces                  |
| `src/core/interceptor/workflow-composition.ts`   | Workflow interceptor composition                                 |
| `src/core/interceptor/activity-composition.ts`   | Activity interceptor composition                                 |
| `src/core/tenant-quotas/types.ts`                | Tenant quota helper types                                        |
| `src/core/tenant-quotas/quota-error.ts`          | `QuotaExceededError`                                             |
| `src/core/tenant-quotas/storage-helpers.ts`      | Tenant quota decoding, measuring, and normalization helpers      |
| `src/core/tenant-quotas/manager-storage.ts`      | Storage-scanning helpers used by `TenantQuotaManager`            |
| `src/core/tenant-quotas/quota-manager.ts`        | `TenantQuotaManager`                                             |

## Compatibility notes

- `src/core/scheduler.ts`, `src/core/schedule.ts`,
  `src/core/checkpoint.ts`, `src/core/codec.ts`, `src/core/events.ts`,
  `src/core/interceptor.ts`, and `src/core/tenant-quotas.ts` keep the canonical
  import paths by re-exporting their directory entrypoints.
- Public barrels re-export the same public symbols that the original files
  exposed. Cross-file helper exports stay internal to the split directories.
- The codec extensions remain registered on a single shared `ExtensionCodec`
  instance before `encode` and `decode` import it.
- `AttributesChangedEvent` is split into an attribute-focused event module so
  every event class remains represented behind the `events` barrel.
- Tenant quota storage-scanning helpers are in their own module so every split
  file stays below the 500-line max-lines threshold.

## Removed suppressions

- `core-scheduler-file-length`
- `core-schedule-file-length`
- `core-checkpoint-file-length`
- `core-codec-file-length`
- `core-events-file-length`
- `core-interceptor-file-length`
- `core-tenant-quotas-file-length`
