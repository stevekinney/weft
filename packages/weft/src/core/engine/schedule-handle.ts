import type {
  ScheduleSpec,
  ScheduleSummary,
  ScheduleTransitionOptions,
  ScheduleUpdateOptions,
} from '../types.ts';

/**
 * Narrow engine view a {@link ScheduleHandle} delegates to. The full
 * {@link Engine} implements it; the handle only depends on these schedule
 * lifecycle operations.
 */
export interface ScheduleHandleEngine {
  pauseSchedule(scheduleId: string, options?: ScheduleTransitionOptions): Promise<void>;
  resumeSchedule(scheduleId: string, options?: ScheduleTransitionOptions): Promise<void>;
  cancelSchedule(scheduleId: string, options?: ScheduleTransitionOptions): Promise<void>;
  updateSchedule(
    scheduleId: string,
    newSpec: string | ScheduleSpec,
    options?: ScheduleUpdateOptions,
  ): Promise<void>;
  getSchedule(scheduleId: string): Promise<ScheduleSummary | null>;
}

/**
 * Handle to a recurring schedule created by {@link Engine.schedule}. Use
 * `handle.pause()`, `handle.resume()`, `handle.cancel()`, or
 * `handle.update(spec, options?)` to manage the schedule lifecycle.
 * `handle.describe()` returns the current {@link ScheduleSummary}.
 *
 * `pause`/`resume`/`cancel` accept an optional {@link ScheduleTransitionOptions}
 * (COR-67) so a caller keeping its own durable projection in step with this
 * schedule can commit its own operations atomically with the status
 * transition — see that type's doc comment for the atomicity guarantee.
 *
 * @example
 * ```ts
 * import { workflow, Engine, ScheduleHandle } from '@lostgradient/weft';
 *
 * const engine = new Engine();
 * engine.register(workflow({ name: 'daily-report' }).execute(async function* () { return 'ok'; }));
 *
 * const handle = await engine.schedule('daily-report', null, '0 9 * * *');
 * const typedHandle: ScheduleHandle = handle;
 * await handle.pause();
 * const summary = await handle.describe();
 * void typedHandle;
 * console.log(summary.status); // 'paused'
 * await handle.cancel();
 * ```
 */
export class ScheduleHandle {
  readonly id: string;
  readonly #engine: ScheduleHandleEngine;

  constructor(id: string, engine: ScheduleHandleEngine) {
    this.id = id;
    this.#engine = engine;
  }

  async pause(options?: ScheduleTransitionOptions): Promise<void> {
    await this.#engine.pauseSchedule(this.id, options);
  }

  async resume(options?: ScheduleTransitionOptions): Promise<void> {
    await this.#engine.resumeSchedule(this.id, options);
  }

  async cancel(options?: ScheduleTransitionOptions): Promise<void> {
    await this.#engine.cancelSchedule(this.id, options);
  }

  async update(newSpec: string | ScheduleSpec, options?: ScheduleUpdateOptions): Promise<void> {
    await this.#engine.updateSchedule(this.id, newSpec, options);
  }

  async describe(): Promise<ScheduleSummary> {
    const schedule = await this.#engine.getSchedule(this.id);
    if (!schedule) {
      throw new Error(`Schedule "${this.id}" not found`);
    }
    return schedule;
  }
}
