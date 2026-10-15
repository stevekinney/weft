---
'@lostgradient/weft': patch
---

A resumed run's durable sleeps keep their deadlines. The first operation after a resume now retires the checkpoint's sleep anchor whatever that operation is, so a later `ctx.sleep` no longer schedules from the crash-time checkpoint and fires early. A replay that re-parks a pending sleep before its deadline keeps the original deadline, where each early wake-up used to push it back by the time already elapsed and a short enough wake-up cadence kept the sleep from ever firing.

The workflow visibility index layout is now version 2, so a state write maintains fewer index rows. A store indexed under version 1 reads as stale, so filtered `engine.list()` and `engine.aggregate()` calls fall back to a full scan until the [workflow visibility backfill](documentation/guides/workflow-visibility-backfill.md) runs again and rebuilds it from empty.
