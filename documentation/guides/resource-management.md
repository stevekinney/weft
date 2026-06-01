# Resource Management

Declare `await using engine = new Engine(...)` and shutdown is automatic on scope exit—pending operations abort, the scheduler stops, internal state clears. No try/finally, no manual `.close()`.

## The pattern

```typescript partial
import { Engine, workflow } from '@lostgradient/weft';
import { SQLiteStorage } from '@lostgradient/weft/storage/sqlite';

declare const orderWorkflow: never; // your registered workflow

{
  await using engine = new Engine({ storage: new SQLiteStorage('./weft.db') });

  engine.register(workflow({ name: 'order' }).execute(orderWorkflow));
  const handle = await engine.start('order', { orderId: 'abc' });
  await handle.result();
} // engine[Symbol.asyncDispose]() called automatically
```

`using` calls `[Symbol.dispose]()` on scope exit; `await using` calls `[Symbol.asyncDispose]()` and awaits it. Both come from TC39's Explicit Resource Management proposal—see [MDN's `using` reference](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Statements/using) if you want the underlying mechanics.

## What is disposable

Every major Weft object implements `Disposable`, `AsyncDisposable`, or both.

_Engine_ implements both. `Symbol.dispose` does immediate teardown—aborts all pending operations, terminates the worker pool, stops the scheduler, and clears caches. `Symbol.asyncDispose` does the same thing (it delegates to the synchronous dispose internally, though future versions may add graceful drain semantics).

```typescript partial
{
  await using engine = new Engine({ storage });
  // ... run workflows ...
} // engine[Symbol.asyncDispose]() called
```

_WorkflowHandle_ implements `AsyncDisposable`. Handles are lightweight, so disposal is currently a no-op—but declaring `await using` on handles is good practice because it documents intent and future-proofs your code.

```typescript partial
{
  await using handle = await engine.start('order', input);
  const result = await handle.result();
} // handle[Symbol.asyncDispose]() called
```

_BunSQLiteStorage_ implements `Disposable`. Disposal closes the underlying SQLite database connection.

`IndexedDBStorage` is the browser-environment equivalent—also `Disposable`—and uses the `await using` pattern. Import it from `'@lostgradient/weft/storage/indexeddb'`.

```typescript partial
{
  using storage = new BunSQLiteStorage('./weft.db');
  const engine = new Engine({ storage });
  // ...
} // storage[Symbol.dispose]() closes the database
```

_MemoryStorage_ implements `Disposable`. Disposal clears the in-memory map.

_Scheduler_ implements `Disposable`. Disposal stops the polling interval.

## Multi-resource orchestration

When you have multiple resources that need coordinated cleanup, use `AsyncDisposableStack`. It disposes resources in reverse order of registration—like Go's `defer`, but type-safe and automatic.

```typescript partial
async function runServer(port: number) {
  await using stack = new AsyncDisposableStack();

  const storage = stack.use(new BunSQLiteStorage('./weft.db'));
  const engine = stack.use(new Engine({ storage }));
  const server = stack.adopt(
    Bun.serve({ port, fetch: (request) => handleRequest(request, engine) }),
    (s) => s.stop(),
  );

  stack.defer(() => console.log('Server shut down cleanly'));

  engine.register(workflow({ name: 'order' }).execute(orderWorkflow));

  console.log(`Weft running on port ${port}`);
  await new Promise((resolve) => {
    process.on('SIGINT', resolve);
    process.on('SIGTERM', resolve);
  });
} // AsyncDisposableStack disposes in reverse order:
// 1. Logs "Server shut down cleanly"
// 2. Stops HTTP server
// 3. Disposes engine
// 4. Closes storage
```

Three methods on the stack are worth knowing:

- `stack.use(resource)` registers a `Disposable` or `AsyncDisposable` and returns it for continued use.
- `stack.adopt(value, onDispose)` registers any value with a custom disposal callback—perfect for things like `Bun.serve()` that are not natively disposable.
- `stack.defer(fn)` registers an arbitrary cleanup function, executed in stack order (just like `defer` in Go).

## Why this matters

In a traditional Node.js application, you might forget to close a database connection in an error path, or leave an interval timer running after a test. These bugs are insidious—they work fine 99% of the time and only manifest under pressure or after hours of uptime.

With `using`, the compiler and runtime _guarantee_ cleanup happens. You cannot forget. If you reach for `new BunSQLiteStorage()`, TypeScript will nudge you toward `using storage = new BunSQLiteStorage()` because the type implements `Disposable`. The resource lifecycle is visible in the code structure, not hidden in a `finally` block three screens away.

Make `using` your default for any Weft resource. Future you, debugging at 3 AM, will be grateful.
