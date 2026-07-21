import type { WeftEventMap } from '../core/events.ts';
import type {
  MessageName,
  QueryDefinition,
  ScheduleSpec,
  ScheduleSummary,
  ScheduleUpdateOptions,
  SearchAttributeValue,
  SignalDefinition,
  SignalDeliveryOptions,
  UpdateDefinition,
} from '../core/types.ts';
import { messageName } from '../core/types.ts';
import type { WorkflowEventTail } from './event-tail.ts';
import type { ClientHandle, ClientScheduleHandle, StartOrSignalOutcome } from './interface.ts';

export interface WorkflowHandleDelegationClient {
  cancel(id: string): Promise<void>;
  suspend(id: string): Promise<void>;
  resume(id: string): Promise<ClientHandle>;
  tail(id: string): WorkflowEventTail;
  signal(
    id: string,
    name: string,
    payload?: unknown,
    options?: SignalDeliveryOptions,
  ): Promise<void>;
  update(
    id: string,
    name: string,
    payload?: unknown,
    options?: { timeout?: number },
  ): Promise<unknown>;
  query(id: string, name: string, input?: unknown): Promise<unknown>;
  getAttributes(id: string): Promise<Record<string, SearchAttributeValue> | null>;
  setAttributes(id: string, attributes: Record<string, SearchAttributeValue>): Promise<void>;
  addTags(id: string, ...tags: string[]): Promise<void>;
  removeTags(id: string, ...tags: string[]): Promise<void>;
}

export abstract class WorkflowHandleDelegation<
  TClient extends WorkflowHandleDelegationClient = WorkflowHandleDelegationClient,
> implements ClientHandle {
  readonly id: string;
  protected readonly client: TClient;
  readonly outcome: StartOrSignalOutcome | undefined;

  constructor(id: string, client: TClient, outcome?: StartOrSignalOutcome) {
    this.id = id;
    this.client = client;
    this.outcome = outcome;
  }

  abstract result(): Promise<unknown>;

  async cancel(): Promise<void> {
    return this.client.cancel(this.id);
  }

  async suspend(): Promise<void> {
    return this.client.suspend(this.id);
  }

  async resume(): Promise<void> {
    // The client's resume() returns a fresh ClientHandle; discard it because the
    // caller already holds this handle, whose result() resolves on completion.
    await this.client.resume(this.id);
  }

  // Duplicate intentionally retained: the signal/update/query overload stacks
  // mirror the engine's `WorkflowHandle`, but TypeScript requires each class to
  // declare its full overload signatures locally to emit them into its `.d.ts`
  // and preserve call-site inference (this class delegates to a `client` field,
  // that one to a private `#engine`, so the bodies cannot share); rejected:
  // hoisting the signatures into a shared interface or mixin, which drops the
  // per-class overload declarations from the emitted declarations.
  // jscpd:ignore-start
  async signal(name: SignalDefinition): Promise<void>;
  async signal<TInput>(
    name: SignalDefinition<TInput>,
    payload: TInput,
    options?: SignalDeliveryOptions,
  ): Promise<void>;
  async signal(name: string, payload?: unknown, options?: SignalDeliveryOptions): Promise<void>;
  async signal(
    nameOrDefinition: MessageName,
    payload?: unknown,
    options?: SignalDeliveryOptions,
  ): Promise<void> {
    if (options === undefined) {
      return this.client.signal(this.id, messageName(nameOrDefinition), payload);
    }
    return this.client.signal(this.id, messageName(nameOrDefinition), payload, options);
  }

  async update<TOutput>(
    name: UpdateDefinition<void, TOutput>,
    payload?: void,
    options?: { timeout?: number },
  ): Promise<TOutput>;
  async update<TInput, TOutput>(
    name: UpdateDefinition<TInput, TOutput>,
    payload: TInput,
    options?: { timeout?: number },
  ): Promise<TOutput>;
  async update(name: string, payload?: unknown, options?: { timeout?: number }): Promise<unknown>;
  async update(
    nameOrDefinition: MessageName,
    payload?: unknown,
    options?: { timeout?: number },
  ): Promise<unknown> {
    return this.client.update(this.id, messageName(nameOrDefinition), payload, options);
  }

  async query<TOutput>(name: QueryDefinition<void, TOutput>): Promise<TOutput>;
  async query<TInput, TOutput>(
    name: QueryDefinition<TInput, TOutput>,
    input: TInput,
  ): Promise<TOutput>;
  async query(name: string, input?: unknown): Promise<unknown>;
  async query(nameOrDefinition: MessageName, input?: unknown): Promise<unknown> {
    return this.client.query(this.id, messageName(nameOrDefinition), input);
  }
  // jscpd:ignore-end

  async getAttributes(): Promise<Record<string, SearchAttributeValue> | null> {
    return this.client.getAttributes(this.id);
  }

  async setAttributes(attributes: Record<string, SearchAttributeValue>): Promise<void> {
    return this.client.setAttributes(this.id, attributes);
  }

  async addTags(...tags: string[]): Promise<void> {
    return this.client.addTags(this.id, ...tags);
  }

  async removeTags(...tags: string[]): Promise<void> {
    return this.client.removeTags(this.id, ...tags);
  }

  tail(): WorkflowEventTail {
    return this.client.tail(this.id);
  }

  /**
   * Default readiness: resolved immediately. Transports whose event stream has
   * connection latency (e.g. the HTTP watch socket) override this to reflect
   * their own connection state.
   */
  whenConnected(): Promise<void> {
    return Promise.resolve();
  }

  abstract addEventListener<K extends keyof WeftEventMap>(
    type: K,
    listener: (event: WeftEventMap[K]) => void,
    options?: boolean | AddEventListenerOptions,
  ): void;
  abstract addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions,
  ): void;

  abstract removeEventListener<K extends keyof WeftEventMap>(
    type: K,
    listener: (event: WeftEventMap[K]) => void,
    options?: boolean | EventListenerOptions,
  ): void;
  abstract removeEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | EventListenerOptions,
  ): void;

  abstract [Symbol.dispose](): void;
}

export interface ScheduleHandleDelegationClient {
  pauseSchedule(id: string): Promise<void>;
  resumeSchedule(id: string): Promise<void>;
  cancelSchedule(id: string): Promise<void>;
  updateSchedule(
    id: string,
    newSpec: string | ScheduleSpec,
    options?: ScheduleUpdateOptions,
  ): Promise<void>;
  getSchedule(id: string): Promise<ScheduleSummary | null>;
}

export abstract class ScheduleHandleDelegation<
  TClient extends ScheduleHandleDelegationClient = ScheduleHandleDelegationClient,
> implements ClientScheduleHandle {
  readonly id: string;
  protected readonly client: TClient;

  constructor(id: string, client: TClient) {
    this.id = id;
    this.client = client;
  }

  async pause(): Promise<void> {
    return this.client.pauseSchedule(this.id);
  }

  async resume(): Promise<void> {
    return this.client.resumeSchedule(this.id);
  }

  async cancel(): Promise<void> {
    return this.client.cancelSchedule(this.id);
  }

  async update(newSpec: string | ScheduleSpec, options?: ScheduleUpdateOptions): Promise<void> {
    return this.client.updateSchedule(this.id, newSpec, options);
  }

  async describe(): Promise<ScheduleSummary | null> {
    return this.client.getSchedule(this.id);
  }

  abstract [Symbol.dispose](): void;
}
