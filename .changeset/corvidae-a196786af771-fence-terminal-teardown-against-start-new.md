---
'@lostgradient/weft': patch
---

A failed, cancelled, timed-out or completed run's terminal teardown no longer wipes the durable state of a same-id `onTerminalConflict: 'start-new'` replacement, including when the replacement runs on another engine. Teardown writes for search attributes, the concurrency slot and holder marker, review entries and the workflow's scratch keys are now guarded on the committing run's stored terminal state, so a replacement that has taken over the id keeps its attributes, slot and scratch state. A replacement in a different concurrency partition no longer leaves the old run's slot behind.
