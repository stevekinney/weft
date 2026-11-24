/**
 * Typed errors raised by the A2A task and push-configuration stores.
 *
 * The three errors a caller causes (a page size outside 1–100, a page token minted
 * for another caller or filter set, and a push-configuration create that conflicts
 * with a stored or deleted configuration) are `RequestMalformedError`s, so the SDK's
 * JSON-RPC transport answers them as `-32602` invalid params. The SDK picks a JSON-RPC
 * error code by `error.name`, so each keeps the name `RequestMalformedError` and is
 * told apart by its `code`. The other two (an unknown stored `recordVersion`, and a
 * write that kept losing its compare-and-swap) are server faults.
 *
 * @module a2a/store-errors
 */

import { RequestMalformedError } from '@a2a-js/sdk/errors';

/** A stored A2A record carries a `recordVersion` this release cannot read. */
export class A2AStoreRecordVersionError extends Error {
  readonly code = 'A2AStoreRecordVersionError' as const;
  /** The storage key of the unreadable record. */
  readonly key: string;
  /** The `recordVersion` the record carries (`undefined` when it has none). */
  readonly recordVersion: unknown;

  constructor(key: string, recordVersion: unknown) {
    super(
      `A2A store record ${key} has recordVersion ${String(recordVersion)}; this release reads only recordVersion 1.`,
    );
    this.name = 'A2AStoreRecordVersionError';
    this.key = key;
    this.recordVersion = recordVersion;
  }
}

/** A write lost its compare-and-swap on every attempt (the first and five retries). */
export class A2AStoreConflictError extends Error {
  readonly code = 'A2AStoreConflictError' as const;
  /** The storage key the write kept losing. */
  readonly key: string;
  /** How many times the write was attempted. */
  readonly attempts: number;

  constructor(key: string, attempts: number) {
    super(`A2A store write to ${key} lost its compare-and-swap ${attempts} times.`);
    this.name = 'A2AStoreConflictError';
    this.key = key;
    this.attempts = attempts;
  }
}

/** A list `pageSize` outside 1–100. */
export class A2AStorePageSizeError extends RequestMalformedError {
  readonly code = 'A2AStorePageSizeError' as const;
  readonly pageSize: number;

  constructor(pageSize: number) {
    super(`pageSize must be an integer from 1 to 100; received ${pageSize}.`);
    this.name = 'RequestMalformedError';
    this.pageSize = pageSize;
  }
}

/** A list `pageToken` that is malformed or was minted for another caller or filter set. */
export class A2AStorePageTokenError extends RequestMalformedError {
  readonly code = 'A2AStorePageTokenError' as const;

  constructor() {
    super('pageToken is not a page token this caller received for this list.');
    this.name = 'RequestMalformedError';
  }
}

/**
 * A push-configuration create named an existing configuration `id` with a different
 * webhook URL, `token`, or authentication, or named a deleted configuration's `id`.
 */
export class A2APushConfigurationConflictError extends RequestMalformedError {
  readonly code = 'A2APushConfigurationConflictError' as const;
  readonly taskId: string;
  readonly configId: string;
  /** `deleted` when the `id` names a deleted configuration, `different` otherwise. */
  readonly conflict: 'deleted' | 'different';

  constructor(taskId: string, configId: string, conflict: 'deleted' | 'different') {
    super(
      conflict === 'deleted'
        ? `Push notification config ${configId} of task ${taskId} was deleted; its id cannot be reused.`
        : `Push notification config ${configId} of task ${taskId} already exists with a different URL, token, or authentication.`,
    );
    this.name = 'RequestMalformedError';
    this.taskId = taskId;
    this.configId = configId;
    this.conflict = conflict;
  }
}
