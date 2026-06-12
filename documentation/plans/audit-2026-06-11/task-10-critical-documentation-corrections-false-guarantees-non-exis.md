# Task 10: Critical documentation corrections (false guarantees, non-existent APIs)

**Severity:** high

## README overclaims activity exactly-once execution for payment workflows

- **Severity:** high (documentation)
- **Files:** `README.md`, `documentation/architecture/tier-0-behavioral-contract.md`

**Evidence:** README.md line 287: 'the charge runs exactly once.' tier-0-behavioral-contract.md line 5 says 'The goal is not blanket exactly-once execution.' activities.md lines 188-191 says 'Activities are at-least-once side effects. Payment providers... still need their own idempotency keys.' The activity reconciliation record that would close the crash window is explicitly marked not yet implemented at tier-0-behavioral-contract.md line 11.

**Required fix:** Change README.md line 287 to qualify the exactly-once claim: clarify that chargeCard may re-execute on crash-before-checkpoint and users must pass an idempotency key to their payment provider. Link to the activities guide's at-least-once callout.

## temporal-comparison.md shows a non-existent engine.start() API overload that cannot compile

- **Severity:** high (documentation)
- **Files:** `documentation/architecture/temporal-comparison.md`, `documentation/architecture/checkpoint-versus-replay.md`

**Evidence:** temporal-comparison.md lines 75-85 shows engine.start('onboard', async (ctx) => {...}, { name: 'Alice' }) — passing an inline async function as the second argument. This overload does not exist. engine.start() takes (type, input, options). The real API requires workflow({ name }).execute(compileStepWorkflow(fn)) + engine.register() + engine.start(type, input). checkpoint-versus-replay.md lines 62-74 shows a non-existent CheckpointSerializationError class; the actual emission is DevelopmentWarningEvent with a bare message string.

**Required fix:** Replace the pseudocode blocks in temporal-comparison.md and checkpoint-versus-replay.md with the actual API pattern. For the error example, show what the engine actually emits: a DevelopmentWarningEvent with message and fieldPaths, and how to listen via engine.addEventListener.

## migration.md falsely claims no breaking changes have been documented, contradicting CHANGELOG

- **Severity:** high (documentation)
- **Files:** `documentation/guides/migration.md`, `CHANGELOG.md`

**Evidence:** migration.md: 'there are no entries yet because no release so far has required migrating existing call sites or data.' CHANGELOG.md line 89: '### Removed — multi-tenancy (BREAKING)' under 0.3.0. CHANGELOG.md lines 398-450 under 0.1.0: '### Removed (breaking)' removing the entire agent surface (~30 exports) with explicit migration guidance already written in the CHANGELOG. Additional breaking renames and removals at lines 153, 265, 285.

**Required fix:** Populate migration.md with a 'Migrating from 0.2.x/0.1.x to 0.3.0' section covering multi-tenancy removal and agent surface removal, using the content already written in CHANGELOG.md. The CHANGELOG has all the content; migration.md needs to surface it as actionable steps.

## WorkflowSuspendNotSupportedError exported from package root but absent from WeftErrorCode union

- **Severity:** medium (dx)
- **Files:** `src/core/weft-error.ts`, `src/core/engine/errors.ts`, `src/index.ts`

**Evidence:** errors.ts line 285 defines WorkflowSuspendNotSupportedError. index.ts line 50 re-exports it. weft-error.ts lines 90-121 publicWeftErrorCodeMap does not include it. isWeftErrorCode('WorkflowSuspendNotSupportedError') returns false. The breaking-changes policy classifies error code changes as breaking for WeftErrorCode-listed classes — this class has no stability contract despite being a public export.

**Required fix:** Add 'WorkflowSuspendNotSupportedError' to the WeftErrorCode union type and to publicWeftErrorCodeMap in src/core/weft-error.ts. The map uses satisfies Record<WeftErrorCode, true> so both additions are required together.

## BranchTopologyChangedError mentioned in docs and thrown publicly but not exported from package root

- **Severity:** medium (dx)
- **Files:** `src/core/context/parallel-cache-entry.ts`, `src/index.ts`, `documentation/guides/parallel-execution.md`

**Evidence:** parallel-execution.md:46 and api-context.md:237 both reference BranchTopologyChangedError by class name as something to catch. src/core/context/parallel-cache-entry.ts:65 defines it. Zero exports in src/index.ts. Also absent from WeftErrorCode. Users cannot write catch (e) { if (e instanceof BranchTopologyChangedError) ... } without an internal import path.

**Required fix:** Export BranchTopologyChangedError from src/index.ts and add it to WeftErrorCode. Update parallel-execution.md to show the catch pattern with instanceof.
