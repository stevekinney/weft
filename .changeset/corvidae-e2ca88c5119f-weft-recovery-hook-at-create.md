---
'@lostgradient/weft': minor
---

`Engine.create` accepts `onRecoveredWorkflow`, the same hook `recoverAll()` takes, and installs it when the engine is created. Under `ownership: 'workflow-lease'` the engine reclaims and resumes stranded workflows on its own interval from the moment it exists, which can be before the host calls `recoverAll()`. A run resumed that early now reaches the hook instead of advancing without one. A hook passed to `recoverAll()` still replaces it.

A resumed `ctx.waitUntil` no longer leaks the checkpoint's time to the next `ctx.sleep`. That sleep used to schedule from the stale time and fire early.
