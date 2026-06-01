# Runtime Support Matrix

Every public entry point and storage adapter, with its supported runtimes.

| Entry Point                                | Bun       | Node 22+   | Browser                             | Edge / CF Workers                |
| ------------------------------------------ | --------- | ---------- | ----------------------------------- | -------------------------------- |
| `@lostgradient/weft` (root)                | yes       | yes        | yes                                 | yes                              |
| `@lostgradient/weft/server`                | yes       | no         | no                                  | no                               |
| `@lostgradient/weft/server/handler`        | yes       | yes        | yes                                 | yes                              |
| `@lostgradient/weft/client`                | yes       | yes        | yes                                 | yes                              |
| `@lostgradient/weft/client/local`          | yes       | yes        | yes                                 | yes                              |
| `@lostgradient/weft/storage/memory`        | yes       | yes        | yes                                 | yes                              |
| `@lostgradient/weft/storage/sqlite`        | yes (bun) | yes (node) | no                                  | no                               |
| `@lostgradient/weft/storage/sqlite/bun`    | yes       | no         | no                                  | no                               |
| `@lostgradient/weft/storage/sqlite/node`   | no        | yes        | no                                  | no                               |
| `@lostgradient/weft/storage/indexeddb`     | no        | no         | yes                                 | conditional (requires IndexedDB) |
| `@lostgradient/weft/storage/web-extension` | no        | no         | conditional (requires WebExtension) | no                               |
| `@lostgradient/weft/storage/http`          | yes       | yes        | yes                                 | yes                              |
| `@lostgradient/weft/storage/resolve`       | yes       | yes        | yes                                 | yes                              |
| `@lostgradient/weft/storage/lmdb`          | yes       | yes        | no                                  | no                               |
| `@lostgradient/weft/storage/turso`         | yes       | yes        | conditional (requires fetch)        | conditional (requires fetch)     |
| `@lostgradient/weft/storage/compressed`    | yes       | yes        | no (requires node:zlib for brotli)  | no                               |
| `@lostgradient/weft/service-worker`        | no        | no         | yes                                 | yes                              |

## Legend

- **yes** — supported and tested.
- **no** — not supported; import resolution will fail cleanly.
- **conditional** — works if the named capability is available in the runtime.

## Notes

- The root `@lostgradient/weft` entry point is portable: it contains no `bun:*`, `node:*`, or filesystem dependencies.
- `serve()` is Bun-only; use `handleRequest()` for portable HTTP handling.
- Storage adapters are isolated behind subpath exports. Heavy backends (`bun:sqlite`, `lmdb`, `better-sqlite3`) are never bundled into the portable root.
