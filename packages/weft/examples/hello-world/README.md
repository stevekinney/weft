# Hello, Weft

The smallest end-to-end Weft example: define an activity, compose it into a
workflow, and run it on an in-memory engine. Everything imports from the
published `@lostgradient/weft` package, so this is a faithful consumer starting point — copy
`src/index.ts` into your own project and swap the dependency for a published
version.

## Run it

This example depends on `@lostgradient/weft` via `"@lostgradient/weft": "file:../.."`, which resolves to the
repository root's **built** output. From the repository root:

```bash
bun install          # root dependencies
bun run build        # produce dist/ — the example resolves @lostgradient/weft from here
cd examples/hello-world
bun install          # link the built weft package into this workspace
bun run start        # runs both workflows and prints their results
```

`bun run verify` typechecks, lints, and runs the example.

> The `bun run build` step at the repository root is required before the
> workspace `bun install`: `weft`'s package entry points at `dist/`, so without
> a build the import will not resolve. The sibling examples
> (`examples/order-processing`, `examples/checkout`) have the same requirement.
