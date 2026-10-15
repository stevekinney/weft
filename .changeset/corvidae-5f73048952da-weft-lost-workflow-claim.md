---
'@lostgradient/weft': minor
---

Add `Engine.lostWorkflowClaim(handle)`. Under `ownership: 'workflow-lease'`, a holder whose claim lapsed and was reclaimed by another engine still sees the workflow's outcome through `handle.result()`, which reads it from the store. Every terminal write now records the engine that committed it, and this method reports `true` once `handle`'s result has settled with an outcome another engine committed. A caller that publishes a run's terminal outcome exactly once can then leave publication to the engine that committed it. The answer belongs to the run the handle drives, so a later `start-new` run under the same workflow ID never changes it.
