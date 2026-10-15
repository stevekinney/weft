---
'@lostgradient/weft': minor
---

Packages can now register namespaced authorization scopes, such as `bureau.tasks:read`, with one handler. Pass them as `additionalScopes` to `serve()` or `createAuthenticator()`. A registered scope can be required by an `AccessPolicy` in `defineOperation`. Weft keeps it when it appears in a JWT `scope`, `scp`, or `permissions` claim, in `defaultApiKeyScopes`, or on a principal admitted by `resolveApiKeyPrincipal` or the rotating key store, and drops any scope that is not registered. A scope that does not match `<namespace>.<resource>:<action>`, or that uses the reserved `weft` namespace, throws at construction. Each handler keeps its own scopes, so two handlers in one process never see each other's. `weft.system.principal`, its OpenRPC result, and the generated client report package scopes. The new `PackageAuthorizationScope` and `BuiltInAuthorizationScope` types are exported.
