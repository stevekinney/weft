import type { ConstraintViolation } from '../constraint.ts';

/**
 * Fired on the {@link Engine} when a serialized checkpoint exceeds the
 * configured size threshold ({@link DEFAULT_CHECKPOINT_SIZE_WARNING_THRESHOLD}).
 * Read `e.sizeBytes` and `e.step` to identify the offending workflow step.
 *
 * @example
 * ```ts
 * import { Engine, CheckpointSizeWarningEvent } from '@lostgradient/weft';
 *
 * const engine = new Engine({ checkpointSizeWarningThreshold: 32_000 });
 * engine.addEventListener(CheckpointSizeWarningEvent.type, (event) => {
 *   console.warn(event.workflowId, 'checkpoint at step', event.step, 'is', event.sizeBytes, 'bytes');
 * });
 * ```
 */
export class CheckpointSizeWarningEvent extends Event {
  static readonly type = 'checkpoint:size-warning' as const;
  readonly workflowId: string;
  readonly sizeBytes: number;
  readonly step: number;

  constructor(workflowId: string, sizeBytes: number, step: number) {
    super(CheckpointSizeWarningEvent.type);
    this.workflowId = workflowId;
    this.sizeBytes = sizeBytes;
    this.step = step;
  }
}

/**
 * Fired on the {@link Engine} (in development mode) when the engine detects
 * a potentially non-deterministic value in the workflow state — such as a Date
 * object, a function, or a class instance. Read `e.message` and `e.fieldPaths`
 * to locate the offending fields.
 *
 * @example
 * ```ts
 * import { Engine, DevelopmentWarningEvent } from '@lostgradient/weft';
 *
 * const engine = new Engine({ development: true });
 * engine.addEventListener(DevelopmentWarningEvent.type, (event) => {
 *   console.warn('[dev]', event.message, 'paths:', event.fieldPaths);
 * });
 * ```
 */
export class DevelopmentWarningEvent extends Event {
  static readonly type = 'development:warning' as const;
  readonly workflowId: string;
  readonly message: string;
  readonly fieldPaths: string[];

  constructor(workflowId: string, message: string, fieldPaths: string[]) {
    super(DevelopmentWarningEvent.type);
    this.workflowId = workflowId;
    this.message = message;
    this.fieldPaths = fieldPaths;
  }
}

export class CleanupWarningEvent extends Event {
  static readonly type = 'cleanup:warning' as const;
  readonly source: string;
  readonly error: Error;
  readonly workflowId: string | undefined;

  constructor(source: string, error: Error, workflowId?: string) {
    super(CleanupWarningEvent.type);
    this.source = source;
    this.error = error;
    this.workflowId = workflowId;
  }
}

/**
 * Fired on the {@link Engine} when the engine measures its total storage
 * footprint during a retention sweep. Read `e.sizeBytes` to track storage
 * growth over time.
 *
 * @example
 * ```ts
 * import { Engine, StorageSizeReportedEvent } from '@lostgradient/weft';
 *
 * const engine = new Engine();
 * engine.addEventListener(StorageSizeReportedEvent.type, (event) => {
 *   console.log('total storage:', event.sizeBytes, 'bytes');
 * });
 * ```
 */
export class StorageSizeReportedEvent extends Event {
  static readonly type = 'storage:size-reported' as const;
  readonly sizeBytes: number;

  constructor(sizeBytes: number) {
    super(StorageSizeReportedEvent.type);
    this.sizeBytes = sizeBytes;
  }
}

/**
 * Fired on the {@link Engine} when a built-in alert metric breaches its
 * threshold. Read `e.metric`, `e.threshold`, `e.currentValue`, and
 * optionally `e.window` to understand which alert triggered.
 *
 * @example
 * ```ts
 * import { Engine, AlertFiredEvent } from '@lostgradient/weft';
 *
 * const engine = new Engine();
 * engine.addEventListener(AlertFiredEvent.type, (event) => {
 *   console.warn('alert fired:', event.metric, 'current:', event.currentValue, 'threshold:', event.threshold);
 * });
 * ```
 */
export class AlertFiredEvent extends Event {
  static readonly type = 'alert:fired' as const;
  readonly metric: string;
  readonly threshold: number;
  readonly currentValue: number;
  readonly window: string | undefined;

  constructor(metric: string, threshold: number, currentValue: number, window?: string) {
    super(AlertFiredEvent.type);
    this.metric = metric;
    this.threshold = threshold;
    this.currentValue = currentValue;
    this.window = window;
  }
}

/**
 * Fired on the {@link Engine} when a previously fired alert returns below its
 * threshold. Mirrors {@link AlertFiredEvent} — read `e.metric`,
 * `e.currentValue`, and `e.threshold` to confirm the recovery.
 *
 * @example
 * ```ts
 * import { Engine, AlertResolvedEvent } from '@lostgradient/weft';
 *
 * const engine = new Engine();
 * engine.addEventListener(AlertResolvedEvent.type, (event) => {
 *   console.log('alert resolved:', event.metric, 'value back to', event.currentValue);
 * });
 * ```
 */
export class AlertResolvedEvent extends Event {
  static readonly type = 'alert:resolved' as const;
  readonly metric: string;
  readonly threshold: number;
  readonly currentValue: number;
  readonly window: string | undefined;

  constructor(metric: string, threshold: number, currentValue: number, window?: string) {
    super(AlertResolvedEvent.type);
    this.metric = metric;
    this.threshold = threshold;
    this.currentValue = currentValue;
    this.window = window;
  }
}

/**
 * Fired on the {@link Engine} when a domain constraint's `check` function
 * returns `false`. Read `e.constraintName`, `e.scope`, and `e.onViolation`
 * to identify which constraint fired and what action the engine took.
 *
 * @example
 * ```ts
 * import { Engine, ConstraintViolatedEvent } from '@lostgradient/weft';
 *
 * const engine = new Engine();
 * engine.addEventListener(ConstraintViolatedEvent.type, (event) => {
 *   console.warn('constraint', event.constraintName, 'violated in', event.workflowId,
 *     'action:', event.onViolation);
 * });
 * ```
 */
export class ConstraintViolatedEvent extends Event {
  static readonly type = 'constraint:violated' as const;
  readonly workflowId: string;
  readonly constraintName: string;
  readonly scope: string;
  readonly onViolation: ConstraintViolation;

  constructor(
    workflowId: string,
    constraintName: string,
    scope: string,
    onViolation: ConstraintViolation,
  ) {
    super(ConstraintViolatedEvent.type);
    this.workflowId = workflowId;
    this.constraintName = constraintName;
    this.scope = scope;
    this.onViolation = onViolation;
  }
}
