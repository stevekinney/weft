---
'@lostgradient/weft': minor
---

Add `Engine.lostWorkflowClaim(workflowId)`. Under `ownership: 'workflow-lease'`, a holder whose claim lapsed and was reclaimed by another engine still sees the workflow's outcome through `handle.result()`, which reads it from the store. This method tells that engine the outcome was not its own. A caller that publishes a run's terminal outcome exactly once can then leave publication to the engine that kept the claim.
