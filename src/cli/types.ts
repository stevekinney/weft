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
    }
  | {
      command: 'server';
      action: 'health' | 'info';
      server?: string;
      token?: string;
      profile?: string;
      wait: boolean;
      waitTimeoutMs: number;
      help: boolean;
      json: boolean;
      quiet: boolean;
    }
  | {
      command: 'workflow';
      action: 'ls';
      server?: string;
      token?: string;
      profile?: string;
      type?: string;
      status?: string;
      limit?: number;
      help: boolean;
      json: boolean;
      quiet: boolean;
    }
  | {
      command: 'workflow';
      action: 'get' | 'events';
      server?: string;
      token?: string;
      profile?: string;
      workflowId: string;
      help: boolean;
      json: boolean;
      quiet: boolean;
    }
  | {
      command: 'workflow';
      action: 'start';
      server?: string;
      token?: string;
      profile?: string;
      workflowType: string;
      input?: string;
      inputFile?: string;
      id?: string;
      help: boolean;
      json: boolean;
      quiet: boolean;
    }
  | {
      command: 'workflow';
      action: 'cancel';
      server?: string;
      token?: string;
      profile?: string;
      workflowId: string;
      yes: boolean;
      dryRun: boolean;
      help: boolean;
      json: boolean;
      quiet: boolean;
    }
  | {
      command: 'workflow';
      action: 'signal';
      server?: string;
      token?: string;
      profile?: string;
      workflowId: string;
      signalName: string;
      input?: string;
      inputFile?: string;
      help: boolean;
      json: boolean;
      quiet: boolean;
    }
  | {
      command: 'tail';
      server?: string;
      token?: string;
      profile?: string;
      workflowId?: string;
      help: boolean;
      json: boolean;
      quiet: boolean;
    }
  | {
      command: 'completions';
      action: 'install' | 'generate';
      shell: CompletionShell;
      help: boolean;
    };

/** Supported shells for `weft completions`. */
export type CompletionShell = 'zsh' | 'bash' | 'fish';

/** Parsed `weft server` command variants. */
export type ServerCommand = Extract<CliCommand, { command: 'server' }>;

/** Parsed `weft workflow` command variants. */
export type WorkflowCommand = Extract<CliCommand, { command: 'workflow' }>;

/** Parsed `weft tail` command. */
export type TailCommand = Extract<CliCommand, { command: 'tail' }>;

/** Parsed `weft completions` command. */
export type CompletionsCommand = Extract<CliCommand, { command: 'completions' }>;

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
