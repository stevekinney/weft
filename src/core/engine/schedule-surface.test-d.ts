/**
 * Type-level pins for the durable timing surface — `ctx.sleep` and
 * `engine.schedule`. These signatures are part of the stable public API; this
 * file fails to typecheck if a refactor narrows, widens, or drops an accepted
 * call form, catching an accidental contract change before release.
 */
import {
  Engine,
  schedule,
  workflow,
  type ScheduleDefinition,
  type ScheduleHandle,
  type ScheduleSpec,
  type WorkflowContext,
} from '../../index.ts';

// ---- ctx.sleep accepts both Duration forms -------------------------------
workflow({ name: 'sleeps' }).execute(async function* (ctx: WorkflowContext) {
  // Milliseconds (number) and duration strings both type-check.
  yield* ctx.sleep(1_000);
  yield* ctx.sleep('30s');
  yield* ctx.sleep('1h');
  // @ts-expect-error sleep requires a duration argument.
  yield* ctx.sleep();
  // @ts-expect-error a duration is a number or string, not a boolean.
  yield* ctx.sleep(true);
});

// ---- engine.schedule overload forms --------------------------------------
declare const engine: Engine;

// Definition form returns a ScheduleHandle.
const fromDefinition: Promise<ScheduleHandle> = engine.schedule({
  workflow: 'sweep',
  cron: '0 9 * * *',
  input: null,
});
void fromDefinition;

// @ts-expect-error the definition form requires `input` (it is not optional).
void engine.schedule({ workflow: 'sweep', cron: '0 9 * * *' });

// Positional form (type, input, cron string) returns a ScheduleHandle.
const fromPositional: Promise<ScheduleHandle> = engine.schedule('sweep', null, '0 9 * * *');
void fromPositional;

// Positional form accepts a ScheduleSpec and ScheduleOptions.
const spec: ScheduleSpec = { every: '5m' };
const fromSpec: Promise<ScheduleHandle> = engine.schedule('sweep', null, spec, {
  overlap: 'skip',
});
void fromSpec;

// @ts-expect-error the positional form requires a spec (cron string or ScheduleSpec).
void engine.schedule('sweep', null);

// The exported `schedule()` definition helper produces a ScheduleDefinition the
// engine accepts — pins that the helper and the engine overload stay aligned.
const sweep = workflow({ name: 'sweep' }).execute(async function* (ctx: WorkflowContext) {
  yield* ctx.sleep(0);
  return 'ok';
});
const definition: ScheduleDefinition = schedule({
  workflow: sweep,
  cron: '0 9 * * *',
  input: undefined,
});
const fromHelper: Promise<ScheduleHandle> = engine.schedule(definition);
void fromHelper;
