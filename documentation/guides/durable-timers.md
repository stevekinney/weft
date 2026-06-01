# Durable Timers

You need a workflow to wait—maybe for an hour before sending a reminder, maybe for 30 days before expiring a trial. A regular `setTimeout` dies with the process. A durable timer survives restarts.

## Sleeping in a workflow

Call `yield* ctx.sleep()` with a human-readable duration string.

```typescript partial
engine.register(
  workflow({ name: 'trial-expiry' }).execute(async function* (ctx, input: { userId: string }) {
    yield* ctx.run('activateTrial', input.userId);
    yield* ctx.sleep('30 days');
    yield* ctx.run('expireTrial', input.userId);
    return { expired: true };
  }),
);
```

That `yield*` is a checkpoint boundary. The timer's fire time is persisted to [storage](storage.md), so if the process restarts tomorrow—or 29 days from now—the workflow picks up where it left off and fires the timer at the right moment.

## Duration formats

You can pass a number (interpreted as milliseconds) or a string with a unit. The parser is case-insensitive and tolerates whitespace between the number and unit.

| Format       | Examples                               |
| ------------ | -------------------------------------- |
| Milliseconds | `500`, `"100ms"`, `"250 milliseconds"` |
| Seconds      | `"30s"`, `"5 seconds"`, `"1 second"`   |
| Minutes      | `"5m"`, `"10 minutes"`, `"1 minute"`   |
| Hours        | `"1h"`, `"2 hours"`, `"1 hour"`        |
| Days         | `"7d"`, `"30 days"`, `"1 day"`         |

Fractional values work too: `"1.5 hours"` is 90 minutes. If you need the raw conversion in your own code, the `parseDuration()` utility is exported.

```typescript
import { parseDuration } from '@lostgradient/weft';

parseDuration('1 hour'); // 3_600_000
parseDuration('30s'); // 30_000
parseDuration(5000); // 5000 (passthrough)
```

## Memoizing derived values

Sometimes you need to compute something once and cache it across checkpoints—a configuration lookup, a random seed, a timestamp for "now." That is what `ctx.memo()` is for.

```typescript partial
engine.register(
  workflow({ name: 'memo-test' }).execute(async function* (ctx) {
    const a = yield* ctx.memo('expensive-value', async () => {
      return await computeSomethingExpensive();
    });

    yield* ctx.sleep('1 hour');

    // After recovery, this returns the cached value without re-executing
    const b = yield* ctx.memo('expensive-value', async () => {
      return await computeSomethingExpensive();
    });

    // a === b, and computeSomethingExpensive() only ran once
    return { a, b };
  }),
);
```

The first call with a given key executes the function and caches the result. Subsequent calls with the same key—even across process restarts—return the cached value. This is useful for anything that should be computed exactly once in a workflow's lifetime, regardless of how many times the generator is replayed or resumed.

Durable timers and memos are small primitives, but they eliminate entire categories of infrastructure: cron jobs, scheduled task databases, cache invalidation logic. The workflow _is_ the scheduler.
