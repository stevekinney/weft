# Engine field initialization order

This document lists the instance fields of `Engine` (formerly `#private`) in
the order they were declared in the pre-PR-8 `src/core/engine.ts`. The
`initializeInternals(engine)` function in
`src/core/engine/internals.ts` creates an empty skeleton; the Engine
constructor body then populates these fields in the same order via
`getInternals(this).fieldName = expr`.

Preserving this ordering is load-bearing for replay determinism: any code
that runs during construction (e.g., `createExecutionStrategyBundle` calling
back into `getRegistration: getInternals(this).registrations.get.bind(...)`)
expects fields to be assigned in this sequence.

| #   | Field                             | Kind                                       |
| --- | --------------------------------- | ------------------------------------------ |
| 1   | `storage`                         | data                                       |
| 2   | `registrations`                   | data                                       |
| 3   | `workflowTypesByHandler`          | data                                       |
| 4   | `abortController`                 | data                                       |
| 5   | `scheduler`                       | data                                       |
| 6   | `options`                         | data                                       |
| 7   | `strategy`                        | data                                       |
| 8   | `inlineStrategy`                  | data (nullable)                            |
| 9   | `handleCache`                     | data                                       |
| 10  | `finalizationRegistry`            | data                                       |
| 11  | `resultResolvers`                 | data                                       |
| 12  | `signalWaiters`                   | data                                       |
| 13  | `signalWaitersByWorkflow`         | data                                       |
| 14  | `updateWaiters`                   | data                                       |
| 15  | `updateWaitersByWorkflow`         | data                                       |
| 16  | `sleepResolvers`                  | data                                       |
| 17  | `sleepResolversByWorkflow`        | data                                       |
| 18  | `interceptors`                    | data                                       |
| 19  | `composedWorkflowInterceptor`     | data (nullable)                            |
| 20  | `composedActivityInterceptor`     | data (nullable)                            |
| 21  | `updateCoordinator`               | data                                       |
| 22  | `activityRegistry`                | data                                       |
| 23  | `activityWorkerDispatcher`        | data (nullable)                            |
| 24  | `checkpoints`                     | data                                       |
| 25  | `broadcastChannel`                | data (nullable)                            |
| 26  | `pendingNestingDepth`             | data (optional)                            |
| 27  | `pendingParentHeaders`            | data (optional)                            |
| 28  | `workflowNestingDepths`           | data                                       |
| 29  | `workflowHeaders`                 | data                                       |
| 30  | `workflowStateWriteChains`        | data                                       |
| 31  | `heartbeatDetails`                | data                                       |
| 32  | `pendingStarts`                   | data                                       |
| 33  | `pendingScheduleCreations`        | data                                       |
| 34  | `workflowsNeedingTerminalCleanup` | data                                       |
| 35  | `cleanupInterval`                 | data (nullable)                            |
| 36  | `retentionSweepInterval`          | data (nullable)                            |
| 37  | `retentionSweepInFlight`          | data (nullable)                            |
| 38  | `nextRetentionSweepAt`            | data (nullable)                            |
| 39  | `reviewCoordinator`               | data                                       |
| 40  | `reviewWaiters`                   | data                                       |
| 41  | `reviewWaitersByWorkflow`         | data                                       |
| 42  | `reviewEscalationHandlers`        | data                                       |
| 43  | `workflowReviewIds`               | data                                       |
| 44  | `parkedInlineWorkflows`           | data                                       |
| 45  | `terminalizingWorkflows`          | data                                       |
| 46  | `reviewTimerIds`                  | data                                       |
| 47  | `pendingWebhooks`                 | data                                       |
| 48  | `alertManager`                    | data (nullable)                            |
| 49  | `agentWorkflowIds`                | inline initializer (`= new Set<string>()`) |
| 50  | `eventLogHeads`                   | inline initializer (`= new Map()`)         |
| 51  | `workflowFeedListeners`           | inline initializer (`= new Map()`)         |
| 52  | `workflowVersionTuples`           | inline initializer (`= new Map()`)         |
| 53  | `pendingTimelineEntries`          | data                                       |

**Note on inline-initializer fields (#49–#52)**: in the pre-PR-8 code these
ran automatically at instance-creation time, before the constructor body. In
the WeakMap pattern they are populated explicitly in the constructor body
near the other field assignments.
