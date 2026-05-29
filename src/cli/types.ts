import type { ScheduleOverlapPolicy } from '../core/types.ts';

/** Supported storage backend identifiers for the `--storage` flag. */
export type StorageBackend = 'sqlite' | 'lmdb' | 'memory';

/** Storage backends suitable for commands that must survive process exit. */
export type PersistentStorageBackend = Exclude<StorageBackend, 'memory'>;

/** Parsed command variants accepted by the CLI runner. */
export type CliCommand =
  | {
      command: 'serve';
      port: string;
      database: string;
      storage: StorageBackend;
      ui: boolean;
      help: boolean;
      workflows?: string;
    }
  | { command: 'doctor'; database: string; help: boolean; json: boolean }
  | {
      command: 'version:check';
      database: string;
      workflows: string;
      help: boolean;
      json: boolean;
    }
  | { command: 'validate'; entryPaths: string[]; help: boolean; json: boolean }
  | {
      command: 'codegen';
      server?: string;
      from?: string;
      token?: string;
      out: string;
      timeoutMs: number;
      help: boolean;
      json: boolean;
    }
  | {
      command: 'api';
      operationName?: string;
      server?: string;
      token?: string;
      profile?: string;
      input?: string;
      inputFile?: string;
      list: boolean;
      describe?: string;
      yes: boolean;
      help: boolean;
      json: boolean;
    }
  | {
      command: 'conformance';
      timeoutMs: number;
      help: boolean;
      json: boolean;
      workerCommand: string[];
    }
  | {
      command: 'timeline';
      database: string;
      workflowId: string;
      step?: number;
      diff?: [number, number];
      help: boolean;
    }
  | {
      command: 'schedule';
      action: 'list';
      database: string;
      storage: PersistentStorageBackend;
      help: boolean;
      json: boolean;
    }
  | {
      command: 'schedule';
      action: 'create';
      database: string;
      storage: PersistentStorageBackend;
      workflows: string;
      workflowType: string;
      cronExpression: string;
      every?: string;
      input: string;
      id?: string;
      overlap?: ScheduleOverlapPolicy;
      backfill: boolean;
      help: boolean;
      json: boolean;
    }
  | {
      command: 'schedule';
      action: 'pause' | 'resume' | 'cancel';
      database: string;
      storage: PersistentStorageBackend;
      scheduleId: string;
      help: boolean;
      json: boolean;
    };

/** Parsed schedule command variants. */
export type ScheduleCommand = Extract<CliCommand, { command: 'schedule' }>;

/** Supported schedule subcommand names. */
export type ScheduleAction = ScheduleCommand['action'];

/** Parsed `weft schedule list` command. */
export type ScheduleListCommand = Extract<ScheduleCommand, { action: 'list' }>;

/** Parsed `weft schedule create` command. */
export type ScheduleCreateCommand = Extract<ScheduleCommand, { action: 'create' }>;

/** Parsed schedule commands that mutate an existing schedule. */
export type ScheduleMutationCommand = Extract<
  ScheduleCommand,
  { action: 'pause' | 'resume' | 'cancel' }
>;

/** Result returned by command executors before the process writes output. */
export interface CommandOutput {
  stdout: string;
  exitCode: number;
  stderr?: string;
}
