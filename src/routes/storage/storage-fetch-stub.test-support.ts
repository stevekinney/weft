/**
 * Test-only `globalThis.fetch` stub for component tests exercising
 * `storage-client.ts` calls through a mounted `.svelte` component (rather
 * than calling the client functions directly, as `storage-client.test.ts`'s
 * `ScriptedFetch` does). Never imported by production code.
 */
export interface StubbedFetchCall {
  readonly url: string;
  readonly method: string;
}

export function stubStorageFetch(
  handler: (call: StubbedFetchCall) => Response | Promise<Response>,
): { calls: StubbedFetchCall[]; restore: () => void } {
  const calls: StubbedFetchCall[] = [];
  const original = globalThis.fetch;

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call: StubbedFetchCall = {
      url: typeof input === 'string' ? input : input.toString(),
      method: init?.method ?? 'GET',
    };
    calls.push(call);
    return handler(call);
  }) as typeof fetch;

  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}
