# Installation

Weft runs on Bun. If you don't have it yet, the install is a one-liner:

```bash
curl -fsSL https://bun.sh/install | bash
```

You'll need Bun 1.3.13 or later. Verify with `bun --version`.

## Library Mode

Most projects should start here. Add Weft as a dependency and use the engine directly in your code.

```bash
bun add @lostgradient/weft
```

That's it. No Docker, no separate server process, no gRPC. You import `Engine` and `MemoryStorage` (or `BunSQLiteStorage`) and start writing workflows.

```typescript
import { Engine, MemoryStorage } from '@lostgradient/weft';

const engine = new Engine({ storage: new MemoryStorage() });
```

For production, swap in SQLite-backed storage so your checkpoints survive process restarts:

```typescript
import { Engine } from '@lostgradient/weft';
import { SQLiteStorage } from '@lostgradient/weft/storage/sqlite';

const engine = new Engine({
  storage: new SQLiteStorage('./weft.db'),
});
```

The database file is created automatically. No migrations to run.

## Standalone Binary

For larger deployments, build a standalone binary with the Weft engine, server, web dashboard, and your workflow code in one artifact. This is useful when you want REST API endpoints, WebSocket worker connections, and application logic with no runtime dependencies on the target machine.

```bash
bun run build:binary
```

The build script (`scripts/build-binary-main.ts`) bundles the Bun runtime, the Weft engine, your workflows, and the server dashboard. For cross-compilation targets, see the script's Bun `--target` options.

## Supported Platforms

Weft produces standalone binaries for these targets:

- `darwin-arm64` (macOS Apple Silicon)
- `darwin-x64` (macOS Intel)
- `linux-x64`
- `linux-arm64`
- `windows-x64`

Cross-compilation works from any OS. A single CI pipeline can produce all five binaries:

```bash
bun build --compile --target=bun-darwin-arm64 src/cli-main.ts --outfile dist/weft-darwin-arm64
bun build --compile --target=bun-linux-x64    src/cli-main.ts --outfile dist/weft-linux-x64
bun build --compile --target=bun-windows-x64  src/cli-main.ts --outfile dist/weft-windows-x64.exe
```

## What Ships Inside the Binary

The compiled binary includes the Bun runtime (with SQLite, HTTP server, and WebSocket built in), the Weft engine and server code, the web dashboard, and default configuration. It does not include native bindings for optional peers — `lmdb`, `@libsql/client`, and `@opentelemetry/api` — install those separately if you use Turso, LMDB, or OpenTelemetry.

## Next Steps

With Weft installed, you're ready to write your first workflow. Head to the [Hello World](hello-world.md) guide.
