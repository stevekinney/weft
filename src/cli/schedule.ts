import type { Engine } from '../core/engine.ts';
import { registerOnRuntimeEngine, runtimeWorkflowEngine } from '../core/runtime-workflow-engine.ts';
import type { WorkflowDefinition } from '../core/types.ts';
import { createStorage } from './storage-factory.ts';
import type {
  CommandOutput,
  ScheduleCommand,
  ScheduleCreateCommand,
  ScheduleListCommand,
  ScheduleMutationCommand,
} from './types.ts';

function formatScheduleCadence(schedule: { cronExpression?: string; intervalMs?: number }): string {
  if (schedule.intervalMs !== undefined) {
    return `every ${schedule.intervalMs}ms`;
  }
  return schedule.cronExpression ?? 'unknown';
}

function formatScheduleLine(schedule: {
  id: string;
  workflowType: string;
  cronExpression?: string;
  intervalMs?: number;
  status: string;
  nextFireAt: number | null;
}): string {
  return [
    schedule.id,
    schedule.workflowType,
    schedule.status,
    formatScheduleCadence(schedule),
    schedule.nextFireAt === null ? 'none' : new Date(schedule.nextFireAt).toISOString(),
  ].join(' | ');
}

function formatScheduleCommandOutput(schedule: unknown, json: boolean, message: string): string {
  return json ? JSON.stringify(schedule, null, 2) : message;
}

function getScheduleStorageValidationError(storage: string): string | null {
  if (storage !== 'memory') {
    return null;
  }

  return 'Error: --storage memory is not supported for schedule commands because data does not persist across CLI invocations';
}

async function executeScheduleList(
  options: ScheduleListCommand,
  engine: Engine,
): Promise<CommandOutput> {
  const result = await engine.listSchedules();
  const stdout = options.json
    ? JSON.stringify(result, null, 2)
    : result.items.length === 0
      ? 'No schedules found.'
      : [
          'ID | Workflow Type | Status | Cadence | Next Fire',
          ...result.items.map(formatScheduleLine),
        ].join('\n');

  return { stdout, exitCode: 0 };
}

function getScheduleCreateValidationError(options: ScheduleCreateCommand): string | null {
  if (!options.workflows) {
    return 'Error: --workflows flag is required for schedule create';
  }

  if (!options.workflowType) {
    return 'Error: missing required argument <workflowType> for schedule create';
  }

  const hasCron = typeof options.cronExpression === 'string' && options.cronExpression.length > 0;
  const hasEvery = options.every !== undefined;
  if (hasCron && hasEvery) {
    return 'Error: provide exactly one of <cronExpression> or --every, not both';
  }
  if (!hasCron && !hasEvery) {
    return 'Error: provide a <cronExpression> argument or an --every <duration> flag for schedule create';
  }

  return null;
}

function parseScheduleInput(
  input: string,
): { ok: true; value: unknown } | { ok: false; message: string } {
  try {
    return { ok: true, value: JSON.parse(input) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, message: `Error: could not parse --input JSON: ${message}` };
  }
}

async function registerScheduleWorkflows(
  engine: Engine,
  workflowsPath: string,
  loadRegistrationsFromModule: (modulePath: string) => Promise<{
    registrations: Record<string, WorkflowDefinition>;
  }>,
): Promise<void> {
  const loaded = await loadRegistrationsFromModule(workflowsPath);
  for (const definition of Object.values(loaded.registrations)) {
    registerOnRuntimeEngine(runtimeWorkflowEngine(engine), definition);
  }
}

async function executeScheduleCreate(
  options: ScheduleCreateCommand,
  engine: Engine,
  loadRegistrationsFromModule: (modulePath: string) => Promise<{
    registrations: Record<string, WorkflowDefinition>;
  }>,
): Promise<CommandOutput> {
  const validationError = getScheduleCreateValidationError(options);
  if (validationError !== null) {
    return { stdout: '', stderr: validationError, exitCode: 1 };
  }

  await registerScheduleWorkflows(engine, options.workflows, loadRegistrationsFromModule);

  const parsedInput = parseScheduleInput(options.input);
  if (!parsedInput.ok) {
    return { stdout: '', stderr: parsedInput.message, exitCode: 1 };
  }

  const spec = options.every !== undefined ? { every: options.every } : options.cronExpression;
  const handle = await engine.schedule(options.workflowType, parsedInput.value, spec, {
    ...(options.id !== undefined ? { id: options.id } : {}),
    ...(options.overlap !== undefined ? { overlap: options.overlap } : {}),
    ...(options.backfill ? { backfill: true } : {}),
    ...(options.jitter !== undefined ? { jitter: options.jitter } : {}),
  });

  const schedule = await handle.describe();
  return {
    stdout: formatScheduleCommandOutput(schedule, options.json, `Created schedule ${handle.id}`),
    exitCode: 0,
  };
}

async function executeScheduleMutation(
  options: ScheduleMutationCommand,
  engine: Engine,
): Promise<CommandOutput> {
  if (!options.scheduleId) {
    return {
      stdout: '',
      stderr: `Error: scheduleId is required for schedule ${options.action}`,
      exitCode: 1,
    };
  }

  if (options.action === 'pause') {
    await engine.pauseSchedule(options.scheduleId);
    const schedule = await engine.getSchedule(options.scheduleId);
    return {
      stdout: formatScheduleCommandOutput(
        schedule,
        options.json,
        `Paused schedule ${options.scheduleId}`,
      ),
      exitCode: 0,
    };
  }

  if (options.action === 'resume') {
    await engine.resumeSchedule(options.scheduleId);
    const schedule = await engine.getSchedule(options.scheduleId);
    return {
      stdout: formatScheduleCommandOutput(
        schedule,
        options.json,
        `Resumed schedule ${options.scheduleId}`,
      ),
      exitCode: 0,
    };
  }

  await engine.cancelSchedule(options.scheduleId);
  const schedule = await engine.getSchedule(options.scheduleId);
  return {
    stdout: formatScheduleCommandOutput(
      schedule,
      options.json,
      `Cancelled schedule ${options.scheduleId}`,
    ),
    exitCode: 0,
  };
}

/** Executes schedule listing, creation, pausing, resuming, and cancellation. */
export async function executeSchedule(options: ScheduleCommand): Promise<CommandOutput> {
  const storageValidationError = getScheduleStorageValidationError(options.storage);
  if (storageValidationError !== null) {
    return {
      stdout: '',
      stderr: storageValidationError,
      exitCode: 1,
    };
  }

  const { Engine } = await import('../core/engine.ts');
  const { loadRegistrationsFromModule } = await import('../diagnostics/validate.ts');
  const storage = await createStorage(options.storage, options.database);
  const engine = new Engine({ storage });

  try {
    if (options.action === 'list') {
      return await executeScheduleList(options, engine);
    }

    if (options.action === 'create') {
      return await executeScheduleCreate(options, engine, loadRegistrationsFromModule);
    }

    return await executeScheduleMutation(options, engine);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { stdout: '', stderr: `Error: ${message}`, exitCode: 1 };
  } finally {
    await engine[Symbol.asyncDispose]();
    storage[Symbol.dispose]();
  }
}
