import { HANG_GUARD_MILLISECONDS, afterAwakeTime } from './hang-guard.ts';

/** Hand control back for one full event-loop turn, then drain microtasks. */
export async function yieldEventLoopTurn(): Promise<void> {
  // load-proof: this is the turn a wait loop takes between two checks of its condition; the loop's condition and the hang guard decide when the wait ends, so the turn carries no assumption about how much work it lets run
  await new Promise<void>((resolve) => {
    const channel = new MessageChannel();
    channel.port1.addEventListener(
      'message',
      () => {
        channel.port1.close();
        channel.port2.close();
        resolve();
      },
      { once: true },
    );
    channel.port1.start();
    channel.port2.postMessage(undefined);
  });
  await Promise.resolve();
}

// A wait that has not finished after this many event-loop turns is waiting on something slower than
// a promise chain (a timer, a child process, the network), so it stops spinning and polls instead.
const SPIN_TURNS = 200;
const POLL_INTERVAL_MILLISECONDS = 5;

const { setTimeout: hostSetTimeout } = globalThis;

async function sleepOnePollInterval(): Promise<void> {
  await new Promise<void>((resolve) => hostSetTimeout(resolve, POLL_INTERVAL_MILLISECONDS));
}

/** Options controlling a condition wait. */
export interface WaitUntilOptions {
  /** What the wait is for, named in the failure. Defaults to `condition`. */
  message?: string;
  /**
   * Hands control back between checks. Defaults to one event-loop turn, then, once a wait has gone
   * on for a couple of hundred turns, to a five-millisecond real timer, so a wait on something slow
   * does not spin the processor away from the thing it waits for. A test that runs under fake
   * timers passes a turn that advances them.
   */
  yieldTurn?: () => Promise<void>;
  /** Awake time after which the wait fails. Only a test of the guard itself shortens it. */
  hangGuardMilliseconds?: number;
  /** Whether fake timers are installed, so awake time cannot be measured. Defaults to never. */
  fakeTimersActive?: () => boolean;
}

async function waitOneTurn(turn: number, options: WaitUntilOptions): Promise<void> {
  if (options.yieldTurn !== undefined) await options.yieldTurn();
  else if (turn <= SPIN_TURNS || options.fakeTimersActive?.() === true) await yieldEventLoopTurn();
  else await sleepOnePollInterval();
}

function armHangGuard(options: WaitUntilOptions, onHung: () => void): () => void {
  const { hangGuardMilliseconds = HANG_GUARD_MILLISECONDS, fakeTimersActive } = options;
  return afterAwakeTime(
    hangGuardMilliseconds,
    onHung,
    fakeTimersActive === undefined ? {} : { fakeTimersActive },
  );
}

/**
 * Wait until `condition` holds, checking it between event-loop turns.
 *
 * This is the wait a test uses for something that must eventually happen, so its only deadline is
 * the awake-time hang guard (`HANG_GUARD_MILLISECONDS`): it fails when the condition never comes,
 * never because a loaded host needed more turns, or more milliseconds, than a fixed cap allowed.
 * A count of turns is a performance bound in disguise, since how many turns a round trip takes
 * depends on the machine. `scripts/check-load-sensitive-deadlines.ts` rejects the loop that
 * counts them.
 */
export async function waitUntil(
  condition: () => boolean | Promise<boolean>,
  options: WaitUntilOptions = {},
): Promise<void> {
  const { message = 'condition', hangGuardMilliseconds = HANG_GUARD_MILLISECONDS } = options;
  let hung = false;
  let turns = 0;
  const cancel = armHangGuard(options, () => {
    hung = true;
  });
  try {
    while (!(await condition())) {
      if (hung) {
        throw new Error(
          `waitUntil gave up after ${hangGuardMilliseconds}ms of awake time waiting for ${message}`,
        );
      }
      turns += 1;
      await waitOneTurn(turns, options);
    }
  } finally {
    cancel();
  }
}

/**
 * The turns of a wait written as a loop: `for await (const turn of awakeTurns()) { ... }` runs its
 * body at once, then again after each event-loop turn, until the body leaves the loop or the
 * awake-time hang guard elapses, when the loop simply ends and the code after it fails the way it
 * always has. It replaces `for (let turn = 0; turn < 50; turn++)`: a count of turns is a
 * performance bound, since how many turns a settle takes depends on the host.
 */
export async function* awakeTurns(options: WaitUntilOptions = {}): AsyncGenerator<number, void> {
  let hung = false;
  const cancel = armHangGuard(options, () => {
    hung = true;
  });
  try {
    for (let turn = 0; ; turn += 1) {
      if (hung) return;
      yield turn;
      await waitOneTurn(turn + 1, options);
    }
  } finally {
    cancel();
  }
}

/**
 * Let `milliseconds` of real time pass so that something that must NOT happen has its chance to.
 *
 * This is for a negative assertion only: "no further event arrives", "the listener is not called
 * again". A busy host can only delay what the test is watching for, never bring it forward, so a
 * test that passes through a quiet window cannot fail because of load. (It can pass when it should
 * not have, which is why the window is also long enough to matter on a healthy host.) To wait for
 * something that must happen, use `waitUntil`: a fixed pause there fails exactly when the host is
 * slow. `scripts/check-load-sensitive-deadlines.ts` rejects a raw sleep in a test body, so the
 * intent of each pause is named at its call.
 */
export async function quietFor(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => hostSetTimeout(resolve, milliseconds));
}
