import { afterEach, describe, expect, it } from 'bun:test';

import {
  compileSvelteHarnessModule,
  createGeneratedArtifactTracker,
  installDashboardDom,
} from '../svelte-test-harness.test-support.ts';

import type {
  AggregateFilter,
  AggregateGroupBy,
  AggregateResult,
  ApiClient,
  BulkCancelResult,
  BulkOperationDryRunResult,
  BulkTagMutationOperation,
  ListFilter,
  PaginatedResult,
  RetentionOverview,
  ScheduleSummary,
  WorkflowSummary,
} from '../api-client.ts';

type WorkflowListApiClient = Pick<
  ApiClient,
  | 'listWorkflows'
  | 'listSchedules'
  | 'getRetentionOverview'
  | 'previewBulkCancelWorkflows'
  | 'commitBulkCancelWorkflows'
  | 'previewBulkDeleteWorkflows'
  | 'commitBulkDeleteWorkflows'
  | 'previewBulkSignalWorkflows'
  | 'commitBulkSignalWorkflows'
  | 'previewBulkTagWorkflows'
  | 'commitBulkTagWorkflows'
  | 'aggregateWorkflows'
>;

type SvelteClientModule = {
  flushSync: () => void;
  mountWorkflowList: (target: Element, apiClient: WorkflowListApiClient) => unknown;
  unmountWorkflowList: (component: unknown) => void | Promise<void>;
};

const COMPONENT_DIRECTORY = new URL('.', import.meta.url).pathname;
const tracker = createGeneratedArtifactTracker();
let flushSvelte = (): void => {};

afterEach(() => {
  tracker.cleanup();
});

function createDeferred<TValue>(): {
  promise: Promise<TValue>;
  resolve: (value: TValue | PromiseLike<TValue>) => void;
  reject: (reason?: unknown) => void;
} {
  let resolvePromise: (value: TValue | PromiseLike<TValue>) => void = () => {};
  let rejectPromise: (reason?: unknown) => void = () => {};
  const promise = new Promise<TValue>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

async function loadWorkflowListHarnessModule(): Promise<SvelteClientModule> {
  const source = `
    import { flushSync, mount, unmount } from 'svelte';
    import WorkflowList from './workflow-list.svelte';
    import type { ApiClient } from '../api-client.ts';

    type WorkflowListApiClient = Pick<
      ApiClient,
      | 'listWorkflows'
      | 'listSchedules'
      | 'getRetentionOverview'
      | 'previewBulkCancelWorkflows'
      | 'commitBulkCancelWorkflows'
      | 'previewBulkDeleteWorkflows'
      | 'commitBulkDeleteWorkflows'
      | 'previewBulkSignalWorkflows'
      | 'commitBulkSignalWorkflows'
      | 'previewBulkTagWorkflows'
      | 'commitBulkTagWorkflows'
      | 'aggregateWorkflows'
    >;

    export { flushSync };

    export function mountWorkflowList(target: Element, apiClient: WorkflowListApiClient): unknown {
      return mount(WorkflowList, {
        target,
        props: {},
        context: new Map([['api-client', apiClient]]),
      });
    }

    export function unmountWorkflowList(component: unknown): void | Promise<void> {
      return unmount(component);
    }
  `;
  // The harness is plain TypeScript (`mount`/`unmount`, no module-scope runes),
  // so it must compile as a `.ts` module, not be routed through Svelte's
  // compileModule.
  return (await compileSvelteHarnessModule({
    componentDirectory: COMPONENT_DIRECTORY,
    harnessBaseName: 'workflow-list-harness',
    harnessExtension: '.ts',
    source,
    tracker,
  })) as SvelteClientModule;
}

function createWorkflowSummary(id: string): WorkflowSummary {
  return {
    id,
    type: 'checkout',
    status: 'running',
    tags: ['nightly'],
    version: '1',
    createdAt: 1_000,
    updatedAt: 2_000,
  };
}

function createWorkflowListResult(
  items: WorkflowSummary[] = [
    createWorkflowSummary('workflow-1'),
    createWorkflowSummary('workflow-2'),
  ],
  options: {
    total?: number;
    offset?: number;
    limit?: number;
  } = {},
): PaginatedResult<WorkflowSummary> {
  return {
    items,
    total: options.total ?? items.length,
    offset: options.offset ?? 0,
    limit: options.limit ?? 20,
  };
}

function createRetentionOverview(): RetentionOverview {
  return {
    defaultRetention: null,
    sweepIntervalMs: 60_000,
    sweepBatchSize: 100,
    nextSweepAt: null,
    workflowTypes: [],
  };
}

function createPreview(requestId: string): BulkOperationDryRunResult {
  return {
    dryRun: true,
    action: 'cancel',
    matched: 2,
    requestId,
    confirmationToken: 'bulk:test-confirmation-token',
    confirmationTokenVersion: 1,
    sampleWorkflowIds: ['workflow-1', 'workflow-2'],
    scope: {
      matched: 2,
      filter: { status: 'running' },
      statuses: ['running'],
      workflowTypes: ['checkout'],
      sampleWorkflowIds: ['workflow-1', 'workflow-2'],
      sampleLimit: 20,
    },
  };
}

function createWorkflowListApiClient(
  options: {
    workflowListResponses?: Array<Promise<PaginatedResult<WorkflowSummary>>>;
    aggregateResponses?: Array<Promise<AggregateResult>>;
    commitCancelResult?: Promise<BulkCancelResult>;
    commitCancelError?: Error;
    onListWorkflows?: (filter: ListFilter | undefined) => void;
    onAggregateWorkflows?: (
      filter: AggregateFilter | undefined,
      groupBy: AggregateGroupBy,
      limit: number | undefined,
    ) => void;
  } = {},
): WorkflowListApiClient {
  const workflowListResponses = [...(options.workflowListResponses ?? [])];
  const aggregateResponses = [...(options.aggregateResponses ?? [])];
  const defaultWorkflowListResponse = Promise.resolve(createWorkflowListResult());
  const defaultAggregateResponse = Promise.resolve({
    total: 2,
    groups: [
      { key: 'running', count: 1 },
      { key: 'failed', count: 1 },
    ],
    truncated: false,
  } satisfies AggregateResult);
  return {
    listWorkflows: (filter?: ListFilter) => {
      options.onListWorkflows?.(filter);
      return workflowListResponses.shift() ?? defaultWorkflowListResponse;
    },
    listSchedules: () =>
      Promise.resolve({
        items: [],
        total: 0,
        offset: 0,
        limit: 20,
      } satisfies PaginatedResult<ScheduleSummary>),
    getRetentionOverview: () => Promise.resolve(createRetentionOverview()),
    previewBulkCancelWorkflows: (_filter: ListFilter, requestId?: string) =>
      Promise.resolve(createPreview(requestId ?? 'bulk:test-request')),
    commitBulkCancelWorkflows: () =>
      options.commitCancelError !== undefined
        ? Promise.reject(options.commitCancelError)
        : (options.commitCancelResult ?? Promise.resolve({ cancelled: 2, failed: 0, errors: [] })),
    previewBulkDeleteWorkflows: (_filter: ListFilter, requestId?: string) =>
      Promise.resolve({ ...createPreview(requestId ?? 'bulk:test-request'), action: 'delete' }),
    commitBulkDeleteWorkflows: () => Promise.resolve({ deleted: 2 }),
    previewBulkSignalWorkflows: (
      _filter: ListFilter,
      _name: string,
      _payload: unknown,
      requestId?: string,
    ) => Promise.resolve({ ...createPreview(requestId ?? 'bulk:test-request'), action: 'signal' }),
    commitBulkSignalWorkflows: () => Promise.resolve({ signalled: 2, failed: 0 }),
    previewBulkTagWorkflows: (
      _filter: ListFilter,
      _tags: string[],
      operation: BulkTagMutationOperation,
      requestId?: string,
    ) =>
      Promise.resolve({
        ...createPreview(requestId ?? 'bulk:test-request'),
        action: operation === 'add' ? 'tag:add' : 'tag:remove',
      }),
    commitBulkTagWorkflows: () => Promise.resolve({ modified: 2 }),
    aggregateWorkflows: (
      filter: AggregateFilter | undefined,
      groupBy: AggregateGroupBy,
      limit: number | undefined,
    ) => {
      options.onAggregateWorkflows?.(filter, groupBy, limit);
      return aggregateResponses.shift() ?? defaultAggregateResponse;
    },
  };
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  flushSvelte();
}

function buttonWithText(label: string): HTMLButtonElement {
  const button = [...document.querySelectorAll('button')].find((candidate) =>
    candidate.textContent?.includes(label),
  );
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error(`Expected to find button with label "${label}"`);
  }
  return button;
}

function statusFilterSelect(): HTMLSelectElement {
  const select = [...document.querySelectorAll('select')].find((candidate) =>
    [...candidate.options].some((option) => option.value === 'running'),
  );
  if (!(select instanceof HTMLSelectElement)) {
    throw new Error('Expected to find the workflow status filter');
  }
  return select;
}

function inputByPlaceholder(placeholder: string): HTMLInputElement {
  const input = [...document.querySelectorAll('input')].find(
    (candidate) => candidate.placeholder === placeholder,
  );
  if (!(input instanceof HTMLInputElement)) {
    throw new Error(`Expected to find input with placeholder "${placeholder}"`);
  }
  return input;
}

function filterContains(
  filter: AggregateFilter | undefined,
  expected: Pick<AggregateFilter, 'idPrefix' | 'failureCategory' | 'createdAt'>,
): boolean {
  if (filter === undefined) return false;
  return (
    filter?.idPrefix === expected.idPrefix &&
    filter.failureCategory === expected.failureCategory &&
    filter.createdAt?.gte === expected.createdAt?.gte &&
    filter.createdAt?.lte === expected.createdAt?.lte
  );
}

async function changeSelectValue(select: HTMLSelectElement, value: string): Promise<void> {
  select.value = value;
  select.dispatchEvent(new Event('change', { bubbles: true }));
  await settle();
}

async function changeInputValue(input: HTMLInputElement, value: string): Promise<void> {
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await settle();
}

async function clickButton(label: string): Promise<HTMLButtonElement> {
  const button = buttonWithText(label);
  button.click();
  await settle();
  return button;
}

async function mountWorkflowList(apiClient: WorkflowListApiClient): Promise<{
  unmount: () => Promise<void>;
  cleanup: () => Promise<void>;
}> {
  const cleanupDom = installDashboardDom((window) => ({
    HTMLButtonElement: window.HTMLButtonElement,
    HTMLMediaElement: window.HTMLMediaElement,
    HTMLSelectElement: window.HTMLSelectElement,
    MouseEvent: window.MouseEvent,
    CustomEvent: window.CustomEvent,
  }));
  try {
    const harnessModule = await loadWorkflowListHarnessModule();
    flushSvelte = harnessModule.flushSync;
    const mounted = harnessModule.mountWorkflowList(document.body, apiClient);
    let unmounted = false;
    flushSvelte();
    await settle();
    async function unmountComponent(): Promise<void> {
      if (unmounted) return;
      await harnessModule.unmountWorkflowList(mounted);
      unmounted = true;
      flushSvelte();
      await settle();
    }
    return {
      unmount: unmountComponent,
      cleanup: async () => {
        await unmountComponent();
        flushSvelte = (): void => {};
        cleanupDom();
      },
    };
  } catch (error) {
    flushSvelte = (): void => {};
    cleanupDom();
    throw error;
  }
}

function installIntervalController(): {
  activeCount: () => number;
  restore: () => void;
  tick: () => void;
} {
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  const callbacks = new Map<number, () => void>();
  let nextHandle = 1;

  globalThis.setInterval = ((
    handler: TimerHandler,
    _timeout?: number,
    ...argumentsList: unknown[]
  ) => {
    const handle = nextHandle;
    nextHandle += 1;
    if (typeof handler !== 'function') {
      throw new Error('String interval handlers are not supported in WorkflowList tests');
    }
    callbacks.set(handle, () => {
      handler(...argumentsList);
    });
    return handle as unknown as ReturnType<typeof setInterval>;
  }) as unknown as typeof setInterval;

  globalThis.clearInterval = ((handle?: ReturnType<typeof setInterval>) => {
    if (handle === undefined) return;
    callbacks.delete(Number(handle));
  }) as typeof clearInterval;

  return {
    activeCount: () => callbacks.size,
    restore: () => {
      globalThis.setInterval = originalSetInterval;
      globalThis.clearInterval = originalClearInterval;
    },
    tick: () => {
      for (const callback of callbacks.values()) {
        callback();
      }
    },
  };
}

function setDocumentHidden(hidden: boolean): void {
  Object.defineProperty(document, 'hidden', {
    configurable: true,
    value: hidden,
  });
}

describe('WorkflowList view', () => {
  it('loads on mount, pauses polling while hidden, resumes when visible, and cleans up', async () => {
    const intervals = installIntervalController();
    let mounted: Awaited<ReturnType<typeof mountWorkflowList>> | undefined;
    let listCalls = 0;
    const apiClient = createWorkflowListApiClient({
      onListWorkflows: () => {
        listCalls += 1;
      },
    });

    try {
      mounted = await mountWorkflowList(apiClient);

      expect(listCalls).toBe(1);
      expect(intervals.activeCount()).toBe(1);

      setDocumentHidden(true);
      document.dispatchEvent(new Event('visibilitychange'));
      await settle();
      intervals.tick();
      await settle();

      expect(intervals.activeCount()).toBe(0);
      expect(listCalls).toBe(1);

      setDocumentHidden(false);
      document.dispatchEvent(new Event('visibilitychange'));
      await settle();

      expect(intervals.activeCount()).toBe(1);
      expect(listCalls).toBe(2);

      intervals.tick();
      await settle();

      expect(listCalls).toBe(3);

      await mounted.unmount();
      expect(intervals.activeCount()).toBe(0);

      document.dispatchEvent(new Event('visibilitychange'));
      intervals.tick();
      await settle();

      expect(listCalls).toBe(3);
    } finally {
      await mounted?.cleanup();
      intervals.restore();
    }
  });

  it('requires a live dry-run preview before enabling bulk confirmation', async () => {
    const apiClient = createWorkflowListApiClient();
    const { cleanup } = await mountWorkflowList(apiClient);
    try {
      expect(buttonWithText('Confirm').disabled).toBe(true);

      await changeSelectValue(statusFilterSelect(), 'running');
      await clickButton('Preview');

      expect(document.body.textContent).toContain('Preview ready: cancel will affect 2 workflows.');
      expect(buttonWithText('Cancel 2 workflows').disabled).toBe(false);

      const actionSelect = document.querySelector<HTMLSelectElement>('#bulk-action');
      if (actionSelect === null) throw new Error('Expected bulk action select');
      await changeSelectValue(actionSelect, 'delete');

      expect(document.body.textContent).not.toContain(
        'Preview ready: cancel will affect 2 workflows.',
      );
      expect(buttonWithText('Confirm').disabled).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it('keeps the current preview active during background polling', async () => {
    const intervals = installIntervalController();
    const pollResponse = createDeferred<PaginatedResult<WorkflowSummary>>();
    const apiClient = createWorkflowListApiClient({
      workflowListResponses: [
        Promise.resolve(createWorkflowListResult()),
        Promise.resolve(createWorkflowListResult()),
        pollResponse.promise,
      ],
    });
    const { cleanup } = await mountWorkflowList(apiClient);
    try {
      setDocumentHidden(false);
      await changeSelectValue(statusFilterSelect(), 'running');
      await clickButton('Preview');
      expect(buttonWithText('Cancel 2 workflows').disabled).toBe(false);

      intervals.tick();
      await settle();

      expect(document.body.textContent).toContain('Preview ready: cancel will affect 2 workflows.');
      expect(buttonWithText('Cancel 2 workflows').disabled).toBe(false);

      pollResponse.resolve(createWorkflowListResult([createWorkflowSummary('workflow-3')]));
      await settle();

      expect(document.body.textContent).toContain('Preview ready: cancel will affect 2 workflows.');
      expect(buttonWithText('Cancel 2 workflows').disabled).toBe(false);
    } finally {
      await cleanup();
      intervals.restore();
    }
  });

  it('invalidates the current preview synchronously when a workflow-list refresh starts', async () => {
    const refreshResponse = createDeferred<PaginatedResult<WorkflowSummary>>();
    const apiClient = createWorkflowListApiClient({
      workflowListResponses: [
        Promise.resolve(createWorkflowListResult()),
        Promise.resolve(createWorkflowListResult()),
        refreshResponse.promise,
      ],
    });
    const { cleanup } = await mountWorkflowList(apiClient);
    try {
      await changeSelectValue(statusFilterSelect(), 'running');
      await clickButton('Preview');
      expect(buttonWithText('Cancel 2 workflows').disabled).toBe(false);

      buttonWithText('Refresh').click();
      flushSvelte();

      expect(document.body.textContent).not.toContain(
        'Preview ready: cancel will affect 2 workflows.',
      );
      expect(buttonWithText('Confirm').disabled).toBe(true);

      refreshResponse.resolve(createWorkflowListResult());
      await settle();
    } finally {
      await cleanup();
    }
  });

  it('invalidates the current preview synchronously when pagination changes', async () => {
    const nextPageResponse = createDeferred<PaginatedResult<WorkflowSummary>>();
    const apiClient = createWorkflowListApiClient({
      workflowListResponses: [
        Promise.resolve(createWorkflowListResult(undefined, { total: 40 })),
        Promise.resolve(createWorkflowListResult(undefined, { total: 40 })),
        nextPageResponse.promise,
      ],
    });
    const { cleanup } = await mountWorkflowList(apiClient);
    try {
      await changeSelectValue(statusFilterSelect(), 'running');
      await clickButton('Preview');
      expect(buttonWithText('Cancel 2 workflows').disabled).toBe(false);

      buttonWithText('Next').click();
      flushSvelte();

      expect(document.body.textContent).not.toContain(
        'Preview ready: cancel will affect 2 workflows.',
      );
      expect(buttonWithText('Confirm').disabled).toBe(true);

      nextPageResponse.resolve(createWorkflowListResult(undefined, { total: 40, offset: 20 }));
      await settle();
    } finally {
      await cleanup();
    }
  });

  it('keeps a manual refresh authoritative when a polling tick overlaps it', async () => {
    const intervals = installIntervalController();
    const refreshResponse = createDeferred<PaginatedResult<WorkflowSummary>>();
    const overlappingPollResponse = createDeferred<PaginatedResult<WorkflowSummary>>();
    const apiClient = createWorkflowListApiClient({
      workflowListResponses: [
        Promise.resolve(createWorkflowListResult()),
        refreshResponse.promise,
        overlappingPollResponse.promise,
      ],
    });
    const { cleanup } = await mountWorkflowList(apiClient);
    try {
      setDocumentHidden(false);

      buttonWithText('Refresh').click();
      flushSvelte();

      intervals.tick();
      await settle();

      overlappingPollResponse.resolve(
        createWorkflowListResult([createWorkflowSummary('poll-bad')]),
      );
      await settle();
      await settle();

      expect(document.body.textContent).not.toContain('poll-bad');

      refreshResponse.resolve(createWorkflowListResult([createWorkflowSummary('refresh-ok')]));
      await settle();
      await settle();

      expect(document.body.textContent).toContain('refresh-ok');
      expect(document.body.textContent).not.toContain('poll-bad');
    } finally {
      await cleanup();
      intervals.restore();
    }
  });

  it('ignores stale polling responses after a committed bulk action refreshes the list', async () => {
    const intervals = installIntervalController();
    const stalePollResponse = createDeferred<PaginatedResult<WorkflowSummary>>();
    const commitRefreshResponse = createDeferred<PaginatedResult<WorkflowSummary>>();
    let nextWorkflowListResponse: 'default' | 'stale-poll' | 'commit-refresh' = 'default';
    const apiClient: WorkflowListApiClient = {
      ...createWorkflowListApiClient(),
      listWorkflows: () => {
        if (nextWorkflowListResponse === 'stale-poll') {
          nextWorkflowListResponse = 'default';
          return stalePollResponse.promise;
        }
        if (nextWorkflowListResponse === 'commit-refresh') {
          nextWorkflowListResponse = 'default';
          return commitRefreshResponse.promise;
        }
        return Promise.resolve(createWorkflowListResult());
      },
    };
    const { cleanup } = await mountWorkflowList(apiClient);
    try {
      setDocumentHidden(false);
      await changeSelectValue(statusFilterSelect(), 'running');
      await clickButton('Preview');
      expect(buttonWithText('Cancel 2 workflows').disabled).toBe(false);

      nextWorkflowListResponse = 'stale-poll';
      intervals.tick();
      await settle();
      nextWorkflowListResponse = 'commit-refresh';
      await clickButton('Cancel 2 workflows');

      commitRefreshResponse.resolve(createWorkflowListResult([]));
      await settle();
      await settle();

      expect(document.body.textContent).toContain('No workflows found');

      stalePollResponse.resolve(createWorkflowListResult());
      await settle();
      await settle();

      expect(document.body.textContent).toContain('No workflows found');
      expect(document.body.textContent).not.toContain('workflow-1');
    } finally {
      await cleanup();
      intervals.restore();
    }
  });

  it('shows confirmation-specific stale token errors and clears preview state', async () => {
    const apiClient = createWorkflowListApiClient({
      commitCancelError: new Error(
        'Bulk confirmation token does not match the current dry-run scope',
      ),
    });
    const { cleanup } = await mountWorkflowList(apiClient);
    try {
      await changeSelectValue(statusFilterSelect(), 'running');
      await clickButton('Preview');
      expect(buttonWithText('Cancel 2 workflows').disabled).toBe(false);

      await clickButton('Cancel 2 workflows');

      expect(document.body.textContent).toContain('Bulk confirmation failed');
      expect(document.body.textContent).toContain(
        'Preview expired. Run preview again before committing.',
      );
      expect(buttonWithText('Confirm').disabled).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it('clears stale success messages before surfacing later commit failures', async () => {
    let commitShouldFail = false;
    const apiClient: WorkflowListApiClient = {
      ...createWorkflowListApiClient(),
      commitBulkCancelWorkflows: () => {
        if (commitShouldFail) {
          return Promise.reject(new Error('Transient bulk commit failure'));
        }
        return Promise.resolve({ cancelled: 2, failed: 0, errors: [] });
      },
    };
    const { cleanup } = await mountWorkflowList(apiClient);
    try {
      await changeSelectValue(statusFilterSelect(), 'running');
      await clickButton('Preview');
      await clickButton('Cancel 2 workflows');

      expect(document.body.textContent).toContain('Cancelled 2 workflows.');

      commitShouldFail = true;
      await clickButton('Preview');
      await clickButton('Cancel 2 workflows');

      expect(document.body.textContent).toContain('Bulk confirmation failed');
      expect(document.body.textContent).toContain('Transient bulk commit failure');
      expect(document.body.textContent).not.toContain('Cancelled 2 workflows.');
    } finally {
      await cleanup();
    }
  });

  it('sends visibility filters to the workflow list and renders status counts', async () => {
    const listFilters: Array<ListFilter | undefined> = [];
    const aggregateCalls: Array<{
      filter: AggregateFilter | undefined;
      groupBy: AggregateGroupBy;
      limit: number | undefined;
    }> = [];
    const apiClient = createWorkflowListApiClient({
      onListWorkflows: (filter) => {
        listFilters.push(filter);
      },
      onAggregateWorkflows: (filter, groupBy, limit) => {
        aggregateCalls.push({ filter, groupBy, limit });
      },
    });
    const { cleanup } = await mountWorkflowList(apiClient);
    try {
      await changeInputValue(inputByPlaceholder('Filter by ID prefix...'), 'order-');
      await clickButton('Application');
      await changeInputValue(
        document.querySelector<HTMLInputElement>('#created-at-gte')!,
        '2026-05-13T09:30',
      );

      const lastFilter = listFilters.at(-1);
      expect(lastFilter).toEqual(
        expect.objectContaining({
          idPrefix: 'order-',
          failureCategory: 'application',
          createdAt: { gte: new Date('2026-05-13T09:30').getTime() },
          limit: 20,
          offset: 0,
        }),
      );

      const expectedAggregateFilter = {
        idPrefix: 'order-',
        failureCategory: 'application',
        createdAt: { gte: new Date('2026-05-13T09:30').getTime() },
      } satisfies Pick<AggregateFilter, 'idPrefix' | 'failureCategory' | 'createdAt'>;
      expect(
        aggregateCalls.some(
          (call) =>
            call.groupBy === 'status' &&
            call.limit === undefined &&
            filterContains(call.filter, expectedAggregateFilter),
        ),
      ).toBe(true);

      expect(document.body.textContent).toContain('Status counts');
      const runningCount = [...document.querySelectorAll('.workflow-status-count')].find(
        (element) => element.textContent?.includes('Running'),
      );
      expect(runningCount?.querySelector('strong')?.textContent).toBe('1');
      expect(document.body.textContent).toContain('Failed');
    } finally {
      await cleanup();
    }
  });
});
