import { afterEach, describe, expect, it } from 'bun:test';

import {
  createActivityWorkerEntryUrl,
  initializeActivityWorkerMessageLoop,
  revokeActivityWorkerEntryUrl,
} from './activity-worker-entry.ts';

type FakeWorkerGlobal = {
  addEventListener: (type: string, listener: (event: MessageEvent<unknown>) => void) => void;
  postMessage: (message: unknown) => void;
};

describe('activity-worker-entry', () => {
  const originalSelf = globalThis.self;
  const originalCreateObjectUrl = URL.createObjectURL;
  const originalRevokeObjectUrl = URL.revokeObjectURL;

  afterEach(() => {
    globalThis.self = originalSelf;
    URL.createObjectURL = originalCreateObjectUrl;
    URL.revokeObjectURL = originalRevokeObjectUrl;
  });

  it('posts a failed result when an unknown activity is requested', async () => {
    let messageListener: ((event: MessageEvent<unknown>) => void) | undefined;
    const postedMessages: unknown[] = [];

    const fakeSelf: FakeWorkerGlobal = {
      addEventListener(_type, listener) {
        messageListener = listener;
      },
      postMessage(message) {
        postedMessages.push(message);
      },
    };

    globalThis.self = fakeSelf as unknown as typeof self;

    initializeActivityWorkerMessageLoop(() => undefined);
    await messageListener?.({
      data: {
        operationId: 'missing-op',
        activityName: 'missing',
        input: null,
        attempt: 1,
      },
    } as MessageEvent<unknown>);

    expect(postedMessages).toEqual([
      {
        operationId: 'missing-op',
        status: 'failed',
        error: 'Unknown activity in worker: "missing"',
      },
    ]);
  });

  it('executes a known activity and posts the completed result', async () => {
    let messageListener: ((event: MessageEvent<unknown>) => void) | undefined;
    const postedMessages: unknown[] = [];

    const fakeSelf: FakeWorkerGlobal = {
      addEventListener(_type, listener) {
        messageListener = listener;
      },
      postMessage(message) {
        postedMessages.push(message);
      },
    };

    globalThis.self = fakeSelf as unknown as typeof self;

    initializeActivityWorkerMessageLoop((name) =>
      name === 'double' ? (input: unknown) => Number(input) * 2 : undefined,
    );

    await messageListener?.({
      data: {
        operationId: 'known-op',
        activityName: 'double',
        input: 21,
        attempt: 1,
      },
    } as MessageEvent<unknown>);

    expect(postedMessages).toEqual([
      {
        operationId: 'known-op',
        status: 'completed',
        value: 42,
      },
    ]);
  });

  it('creates a blob URL for serializable handlers', async () => {
    let capturedBlob: Blob | undefined;

    URL.createObjectURL = (blob: Blob) => {
      capturedBlob = blob;
      return 'blob:activity-worker-entry';
    };

    const url = createActivityWorkerEntryUrl(
      new Map([
        [
          'safe',
          function safeHandler(input: unknown) {
            const note = 'this string mentions import() and require() without using them';
            void note;
            return String(input).toUpperCase();
          },
        ],
      ]),
    );

    expect(url).toBe('blob:activity-worker-entry');
    const script = await capturedBlob?.text();
    expect(script).toContain('activities.set("safe"');
    expect(script).toContain('initializeActivityWorkerMessageLoop');
  });

  it('rejects handlers that reference this', () => {
    expect(() =>
      createActivityWorkerEntryUrl(
        new Map([
          [
            'uses-this',
            function usesThis(this: { value: string }) {
              return this.value;
            },
          ],
        ]),
      ),
    ).toThrow('references `this`');
  });

  it('rejects handlers that use require()', () => {
    expect(() =>
      createActivityWorkerEntryUrl(
        new Map([
          [
            'uses-require',
            function usesRequire() {
              return require('node:path');
            },
          ],
        ]),
      ),
    ).toThrow('uses `require()`');
  });

  it('rejects handlers that use dynamic import()', () => {
    expect(() =>
      createActivityWorkerEntryUrl(
        new Map([
          [
            'uses-import',
            async function usesImport() {
              return import('./activity-runner.ts');
            },
          ],
        ]),
      ),
    ).toThrow('uses dynamic `import()`');
  });

  it('rejects native handlers that cannot be serialized', () => {
    expect(() =>
      createActivityWorkerEntryUrl(
        new Map([['native-handler', Math.max as (input: unknown) => unknown]]),
      ),
    ).toThrow('is a native function');
  });

  it('revokes previously-created worker entry URLs', () => {
    const revokedUrls: string[] = [];
    URL.revokeObjectURL = (url: string) => {
      revokedUrls.push(url);
    };

    revokeActivityWorkerEntryUrl('blob:revoke-me');

    expect(revokedUrls).toEqual(['blob:revoke-me']);
  });
});
