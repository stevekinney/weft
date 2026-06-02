---
name: tdd-workflow
description: >-
  Test-driven development workflow for weft using Bun's test runner,
  TestEngine, TimeControl, and ActivityMockRegistry. Use when writing
  new features, fixing bugs, or implementing acceptance criteria. Trigger
  on: "write tests for", "TDD", "test-driven", "add tests", "implement
  with tests", "red green refactor", or any task that involves writing
  both tests and implementation code.
---

# TDD Workflow

Write the test first, watch it fail, make it pass, then clean up. This is the red-green-refactor cycle applied to weft's durable execution engine.

## When to Activate

- Implementing a new feature or behavior
- Fixing a bug (write a test that reproduces it first)
- Adding a new workflow pattern or activity
- Extending the server API with new routes
- Adding or modifying storage backend behavior

## The Cycle

### Red: Write a Failing Test

Write the test that describes the expected behavior. Run it and confirm it fails for the right reason.

```bash
bun test src/core/my-feature.test.ts
```

### Green: Make It Pass

Write the minimum code to make the test pass. Do not optimize or refactor yet.

### Refactor: Clean Up

With passing tests as a safety net, improve the code. Extract helpers, rename for clarity, remove duplication. Run the test after each change to confirm nothing broke.

## Weft Testing Tools

### TestEngine — Workflow Behavior Tests

`TestEngine` wraps the core `Engine` with `MemoryStorage`, virtual time, and activity mocking. Use it for any test that involves running workflows.

```typescript
import { describe, it, expect } from 'bun:test';
import { workflow } from '@lostgradient/weft';
import { TestEngine } from '@lostgradient/weft/testing';

const myWorkflow = workflow({ name: 'my-workflow' }).execute(async function* (
  _ctx,
  input: { input: string },
) {
  return { output: input.input };
});

describe('my workflow', () => {
  it('completes with the expected result', async () => {
    await using engine = new TestEngine();
    engine.register(myWorkflow);

    const handle = await engine.start('my-workflow', { input: 'value' });
    const result = await handle.result();

    expect(result).toEqual({ output: 'expected' });
  });
});
```

Key methods:

- `new TestEngine({ startTime? })` — creates an engine with MemoryStorage and virtual clock
- `engine.storage` — direct access to `MemoryStorage` for assertions on persisted state
- `engine.mocks` — direct access to `ActivityMockRegistry`

### TimeControl — Time-Dependent Flows

Use `testEngine.advanceTime(duration)` to move virtual time forward. Duration strings like `'100ms'`, `'5s'`, `'1m'`, `'2h'` are parsed by `parseDuration()`.

```typescript
it('retries after a delay', async () => {
  await using engine = new TestEngine();
  engine.register(retryWorkflow);

  const handle = await engine.start('retry-workflow', {});

  // Advance past the retry delay
  await engine.advanceTime('30s');

  const result = await handle.result();
  expect(result.attempts).toBe(2);
});
```

TimeControl does NOT monkey-patch global timers. It provides an explicit virtual clock that the engine's scheduler respects.

### ActivityMockRegistry — Activity Isolation

Use `testEngine.mock(activity, implementation)` to substitute activity implementations. Returns a `MockHandle` for inspecting calls.

```typescript
it('calls the payment activity with the right amount', async () => {
  await using engine = new TestEngine();
  engine.register(checkoutWorkflow);

  const paymentMock = engine.mock(chargePayment, async (amount: number) => {
    return { transactionId: 'test-txn-123' };
  });

  await engine.start('checkout', { amount: 42 });

  expect(paymentMock.callCount).toBe(1);
  expect(paymentMock.lastCall?.args).toEqual([42]);
});
```

MockHandle API:

- `.calls` — read-only array of `MockCall` objects (each has `args`, `result`, `error`, `timestamp`)
- `.callCount` — number of times the mock was called
- `.lastCall` — most recent `MockCall` or `undefined`
- `.mockImplementation(fn)` — replace the mock's base implementation
- `.mockReturnValueOnce(value)` — queue a one-shot return value
- `.mockRejectionOnce(error)` — queue a one-shot rejection
- `.resetCalls()` — clear call history
- `.restore()` — remove the mock entirely

### Engine Recovery — Checkpoint Replay

Use `testEngine.recover()` to simulate a process restart. The recovered engine sees all persisted state but has fresh in-memory structures.

```typescript
it('resumes from checkpoint after restart', async () => {
  await using engine = new TestEngine();
  engine.register(durableWorkflow);

  const handle = await engine.start('durable-workflow', {});
  // Let it checkpoint some progress...

  const recovered = engine.recover();
  recovered.register(durableWorkflow);
  // The recovered engine picks up where the original left off
});
```

## Test File Conventions

- Colocate tests: `src/core/engine.test.ts` next to `src/core/engine.ts`
- Use `describe`/`it`/`expect` from `bun:test`
- Descriptive test names: "returns empty array when no workflows match filter"
- AAA pattern: Arrange (set up), Act (execute), Assert (verify)
- Test files have relaxed linting: `any`, non-null assertions, and unused variables are allowed

## Choosing the Right Tool

| Scenario                                              | Tool                                                          |
| ----------------------------------------------------- | ------------------------------------------------------------- |
| Pure function logic (parsers, validators, formatters) | Direct `expect()` assertions                                  |
| Workflow execution and lifecycle                      | `TestEngine`                                                  |
| Time-dependent behavior (delays, retries, timeouts)   | `TestEngine` + `advanceTime()`                                |
| External service calls (APIs, databases)              | `TestEngine` + `mock()`                                       |
| Crash recovery and checkpoint resume                  | `TestEngine` + `recover()`                                    |
| Server HTTP route behavior                            | Direct calls to `handleRequest(request, engine)`              |
| Storage backend behavior                              | Direct instantiation of `MemoryStorage` or `BunSQLiteStorage` |
