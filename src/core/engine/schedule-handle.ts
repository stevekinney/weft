import type { ScheduleSpec, ScheduleSummary, ScheduleUpdateOptions } from '../types.ts';

/**
 * Narrow engine view a {@link ScheduleHandle} delegates to. The full
 * {@link Engine} implements it; the handle only depends on these schedule
 * lifecycle operations.
 */
export interface ScheduleHandleEngine {
  pauseSchedule(scheduleId: string): Promise<void>;
  resumeSchedule(scheduleId: string): Promise<void>;
  cancelSchedule(scheduleId: string): Promise<void>;
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

  async pause(): Promise<void> {
    await this.#engine.pauseSchedule(this.id);
  }

  async resume(): Promise<void> {
    await this.#engine.resumeSchedule(this.id);
  }

  async cancel(): Promise<void> {
    await this.#engine.cancelSchedule(this.id);
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
