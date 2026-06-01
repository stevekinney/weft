# Subprocess Durability Tests

Use the subprocess harness when a test needs to prove behavior across a real server process boundary. In-process recovery tests are still useful for engine algorithms, but they do not prove that an operator-style server process can be killed and restarted against the same durable storage.

Import the harness from `@lostgradient/weft/testing`:

```ts
import { killAndReboot, spawnServerSubprocess } from '@lostgradient/weft/testing';
```

The harness starts a Bun subprocess, waits for a readiness line, captures stdout and stderr, and reboots against the same database path after a signal:

```ts
import { killAndReboot, spawnServerSubprocess } from '@lostgradient/weft/testing';

const server = await spawnServerSubprocess({
  entrypoint: './tmp/test-entrypoint.ts',
  databasePath: './tmp/weft-durability.db',
  port: 0,
});

const rebooted = await killAndReboot(server, 'SIGKILL');
```

The child receives only a small runtime environment by default (`PATH`, home and temporary-directory variables, `TZ`, and `NODE_ENV`). Pass any test-specific variables through `env` explicitly so CI tokens, registry credentials, and local secrets are not available to temporary entrypoints by accident.

Durability tests should use on-disk SQLite, not `:memory:`. A process death destroys memory storage, so it cannot prove recovery. Keep each test database in a temporary directory and clean up the database plus SQLite sidecar files (`-wal`, `-shm`) after the test.

Temporary entrypoints should import the same production primitives that an application uses: `Engine`, the storage backend, and `serve()`. Register workflows and activities before calling `engine.recoverAll()`, then print `WEFT_SUBPROCESS_READY <url>` after `serve()` binds. The test should interact with the server over HTTP or WebSocket rather than reaching into the subprocess engine.

Prefer observable conditions over fixed waits. For example, poll workflow state, a readiness line, a task counter file, or a worker registration endpoint. The harness caps startup and exit waits, and failures include captured subprocess stderr so crashes do not disappear into a hung test.
