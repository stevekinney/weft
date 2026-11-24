import { WeftError } from '../weft-error.ts';

/** Which engine-owned durable write a {@link CheckpointCommitFailedError} gave up on. */
export type RefusedStorageWrite = 'checkpoint' | 'completion' | 'failure';

/**
 * Thrown when storage refused one of a workflow's engine-owned writes on every attempt the engine
 * makes in process: the checkpoint batch (`wf:<id>:ckpt` and the `ev:<id>:*` event-log records
 * together), the terminal `wf:<id>` write of a completion, or the `wf:<id>` write of a failure.
 * The engine retries a refused write a bounded number of times (the first attempt and four
 * retries, 750 ms of waiting in all) before it raises this error, which carries the workflow, the
 * write, the attempt count, and the last storage error as `cause`.
 *
 * A refused checkpoint or completion write then fails the workflow as a `system` failure with this
 * error, so `handle.result()` rejects with it. A refused failure write leaves nothing durable to
 * write, so the engine stops driving the generation locally and rejects the pending `result()`
 * with it; the durable record stays `running` and the next boot recovers it from its last
 * committed checkpoint.
 *
 * The message is a fixed sentence naming the workflow, the write and, when the engine counted
 * them, the attempts (a write refused on every attempt; an error no code classified carries no
 * count, so the message states none rather than a wrong one). The storage
 * adapter's own error, which can name tables, constraints or paths, is only on `cause`, so the
 * message can reach clients as a run's error.
 *
 * Like `CheckpointEncodingError` it is neither exported from the package root nor registered
 * in `WeftErrorCode`, so the public error vocabulary does not change.
 */
export class CheckpointCommitFailedError extends WeftError<'CheckpointCommitFailedError'> {
  readonly workflowId: string;
  /** The write the engine gave up on. */
  readonly write: RefusedStorageWrite;
  /**
   * How many times the engine attempted the write, the first attempt included; `undefined` when
   * the write failed for a reason the engine did not count, such as an error no code classified.
   */
  readonly attempts: number | undefined;
  /**
   * The execution token of the generation whose write was refused, captured with the write so an
   * abandonment is scoped to that generation, as `WorkflowCheckpointConflictError`'s is.
   */
  readonly workflowExecutionToken: string | undefined;

  constructor(
    workflowId: string,
    options: {
      readonly write: RefusedStorageWrite;
      readonly attempts?: number;
      readonly cause: unknown;
      readonly workflowExecutionToken: string | undefined;
    },
  ) {
    // A fixed sentence: the storage adapter's own text can name tables, constraints or paths, and
    // this message reaches clients as a run's error. It stays on `cause`, for the operator.
    super(
      'CheckpointCommitFailedError',
      `Workflow "${workflowId}" ${options.write} write was not committed` +
        (options.attempts === undefined
          ? '.'
          : ` after ${String(options.attempts)} ${options.attempts === 1 ? 'attempt' : 'attempts'}.`),
      { cause: options.cause },
    );
    this.workflowId = workflowId;
    this.write = options.write;
    this.attempts = options.attempts;
    this.workflowExecutionToken = options.workflowExecutionToken;
  }
}
