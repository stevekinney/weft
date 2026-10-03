# Single Binary Distribution

`bun build --compile` produces standalone executables that include the Bun runtime, all your code, and embedded assets. End users download one file and run it. No runtime to install, no dependencies to manage, no Docker required.

## Building for every platform

The build script produces binaries for five targets. Run the Darwin targets on macOS so they receive valid signatures; Linux and Windows targets can run on other hosts.

```bash
bun run build:binary --target darwin-arm64
bun run build:binary --target darwin-x64
bun run build:binary --target linux-x64
bun run build:binary --target linux-arm64
bun run build:binary --target windows-x64
```

On a Mac, `bun run build:binary --all` can build all five. On Linux, request only Linux or Windows targets; a Darwin target fails before compilation because the output cannot be signed there.

## What ships inside

The binary bundles everything the engine needs to run:

- The Bun runtime (includes SQLite, HTTP server, WebSocket, and more)
- Weft engine, server, and worker code
- Default configuration

What does _not_ ship inside (and shouldn't): LMDB native bindings (opt-in via `bun add lmdb` when you need them) and your workflow/activity code (loaded at runtime or compiled into your own binary).

## Three distribution modes

**Standalone server.** Download and run. SQLite is auto-created and the API is available immediately.

```bash
curl -L https://github.com/stevekinney/weft/releases/download/v1/weft-darwin-arm64 -o weft
chmod +x weft
./weft --port 7233
```

**Library.** Import Weft into your own project and use the engine programmatically.

```bash
bun add @lostgradient/weft
```

**User-compiled binary.** Bake your workflow code _into_ the Weft binary for a fully self-contained application.

```bash
bun build --compile src/my-app.ts --outfile my-app
# my-app includes Weft engine + your workflow code in one binary
```

The third mode is the interesting one for production. Your entire application—server, engine, workflows, and activities—compiles into a single file that you `scp` to a server and run. No container orchestration, no dependency management, no "works on my machine."
