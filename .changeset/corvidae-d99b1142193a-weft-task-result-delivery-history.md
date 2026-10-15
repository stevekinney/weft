---
'@lostgradient/weft': minor
---

Two new operations expose what happened to a task's results. `weft.tasks.deliveries` (`GET /v1/tasks/detail/:operationId/deliveries`, `system:read`) returns every answered `taskResult` submission for an operation, oldest first, from both the WebSocket and long-poll transports: an acknowledged entry carries its `applied`, `duplicate` or `dead-lettered` disposition, and a rejected entry carries a rejection code and reason. `weft.tasks.deadletters.get` (`GET /v1/tasks/detail/:operationId/dead-letter`, `system:admin`) returns a dead-lettered attempt's retained result value, bounded by `maxBytes`. A new client-visible `task:result-delivery` event, typed as `TaskResultDeliveryEvent`, reports each recorded delivery. Both operations are in the generated operations client.
