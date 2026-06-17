/**
 * In-process handle wrappers for {@link LocalClient}. Split out of
 * `client/local.ts` to keep that module under the per-file line ceiling.
 *
 * @module client/local-handles
 */

import type { WorkflowHandle } from '../core/engine.ts';
import type { WeftEventMap } from '../core/events.ts';
import { ScheduleHandleDelegation, WorkflowHandleDelegation } from './handle-delegation.ts';
import type { StartOrSignalOutcome } from './interface.ts';
import type { LocalClient } from './local.ts';

// ---------------------------------------------------------------------------
// LocalHandle — wraps Engine's WorkflowHandle
// ---------------------------------------------------------------------------

export class LocalHandle extends WorkflowHandleDelegation<LocalClient> {
  readonly #handle: WorkflowHandle;

  constructor(handle: WorkflowHandle, client: LocalClient, outcome?: StartOrSignalOutcome) {
    super(handle.id, client, outcome);
    this.#handle = handle;
  }

  async result(): Promise<unknown> {
    return this.#handle.result();
  }

  addEventListener<K extends keyof WeftEventMap>(
    type: K,
    listener: (event: WeftEventMap[K]) => void,
    options?: boolean | AddEventListenerOptions,
  ): void;
  addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions,
  ): void {
    this.#handle.addEventListener(type, listener, options);
  }

  removeEventListener<K extends keyof WeftEventMap>(
    type: K,
    listener: (event: WeftEventMap[K]) => void,
    options?: boolean | EventListenerOptions,
  ): void;
  removeEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | EventListenerOptions,
  ): void {
    this.#handle.removeEventListener(type, listener, options);
  }

  [Symbol.dispose](): void {
    // LocalHandle has no resources to clean up — events flow through
    // the engine's EventTarget which is managed by the engine lifecycle.
  }
}

export class LocalScheduleHandle extends ScheduleHandleDelegation<LocalClient> {
  [Symbol.dispose](): void {
    // Local schedule handles do not hold long-lived resources.
  }
}
