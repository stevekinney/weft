import { UpdateTimeoutError } from '../updates.ts';

/**
 * Park until a waiting `ctx.waitForUpdate` handler responds (via the resolver it
 * registered in `updateWaiters`) or the update times out. Resolves with the
 * handler's response value; rejects with {@link UpdateTimeoutError} when the
 * timeout elapses first. The `respond` callback is single-shot — a late second
 * response is ignored.
 */
export async function waitForUpdateResponse(
  updateId: string,
  payload: unknown,
  timeout: number,
  updateWaiter: (request: unknown) => void,
): Promise<unknown> {
  const { promise: respondPromise, resolve: resolveRespond } = Promise.withResolvers<unknown>();
  let responded = false;
  const respond = (value: unknown) => {
    if (responded) return;
    responded = true;
    resolveRespond(value);
  };

  updateWaiter({ payload, respond });
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      respondPromise,
      new Promise<never>((_resolve, reject) => {
        timeoutId = setTimeout(() => reject(new UpdateTimeoutError(updateId, timeout)), timeout);
      }),
    ]);
  } finally {
    clearTimeout(timeoutId);
  }
}
