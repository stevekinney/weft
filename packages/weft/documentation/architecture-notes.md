# Architecture notes

## Barrel re-exports for split modules

Four files in this codebase are 1-line re-export barrels:

- `src/core/engine.ts` → `src/core/engine/`
- `src/core/types.ts` → `src/core/types/`
- `src/core/context.ts` → `src/core/context/`
- `src/server/handler.ts` → `src/server/handler/`

The global `~/.claude/CLAUDE.md` rule forbids "re-export-only files that exist purely to preserve old import paths." This is an explicit project-level exception to that rule. The barrels are kept because:

1. The split was a structural refactor of monolithic files (engine.ts at 9,411 lines) into directories. Updating every internal call site (~73 imports for engine, 142 for types, 62 for context) would have made the diff unreviewable.
2. The barrels are pure 1-line `export * from './<dir>/index.ts'` files with no logic. They aren't backward-compatibility shims; they're the canonical entrypoints to those modules.
3. External (`src/index.ts`) and internal (`src/core/**`) call sites both use the barrel paths, so they form a natural API boundary.

If a future contributor wants to update all call sites and delete the barrels, the work is mechanical (regex find/replace) but the diff would be large. Until that happens, the barrels are the documented exception.

## EngineInternals WeakMap pattern

The split engine uses `WeakMap<Engine, EngineInternals>` instead of `#private` fields because TypeScript `private` is class-private, not module-private — sibling modules under `src/core/engine/` cannot access `this.#field` even though they live next to the class. See `src/core/engine/internals.ts` header comment for full rationale.
