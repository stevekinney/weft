---
'@lostgradient/weft': minor
---

Two new operations serve RemoteWorker protocol conformance reports that were previously available only from the `weft conformance` CLI. `weft.conformance.targets` (`GET /v1/conformance/targets`, `system:read`) lists the targets a server can run, by name and per-wait timeout, and never returns their commands. `weft.conformance.report` (`POST /v1/conformance/targets/:target/report`, `system:admin`) runs the check sequence against one target inside a private sandbox server and returns every named check with its verdict and message, plus protocol version metadata. A request names a target only; targets are fixed at boot with `createConformanceTargets` from `@lostgradient/weft/testing` and passed to `serve({ conformanceTargets })`. Both operations are in the generated operations client, and the CLI now shares the same check sequence. A run also stops the reconnect check's replacement worker when that worker never registers.
