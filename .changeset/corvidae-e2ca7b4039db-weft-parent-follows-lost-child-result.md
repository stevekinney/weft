---
'@lostgradient/weft': patch
---

A parent that awaits a child its engine lost to a checkpoint compare-and-swap race (`ownership: 'none'`) now settles from the winner's durable child outcome instead of staying parked forever: it completes with the child's result, fails with the child's failure, or rejects like a missing workflow if that child generation is gone. The parent stays parked, without an error, if the winner never finishes the child.
