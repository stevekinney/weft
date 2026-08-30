# Checkout Example

If you want a tiny checkout flow you can run locally, this example charges payment, reserves inventory, sends a confirmation, and schedules shipping. It imports [Weft](https://github.com/stevekinney/weft) the same way an application does while using the repository package through a local `file:../..` dependency.

## Run It

```bash
# From the repository root:
bun install
bun run build
cd examples/checkout
bun install
bun run start
```

The example stores workflow state in `./checkout.sqlite` with [SQLite](https://www.sqlite.org/). Set `WEFT_CHECKOUT_DATABASE_PATH` to use a different file:

```bash
WEFT_CHECKOUT_DATABASE_PATH=/tmp/weft-checkout.sqlite bun run start
```

Run the verification gate:

```bash
bun run verify
```

`bun run verify` uses temporary storage in tests, so it does not leave a database file in the example directory.

## What To Look For

- The workflow is defined with `workflow({ name: 'checkout' }).activities({ ... }).execute(...)`.
- Activities are scoped to the workflow instead of registered globally.
- SQLite persists checkpoints, so the workflow has a real durable backing store even though the example is small.
