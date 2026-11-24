/**
 * Starting and attaching to a peer task: validates the caller's request, builds the opening
 * message, and ties the task to the caller's abort signal.
 *
 * @module a2a/peer-task-start
 */

import { Role, type Message, type SendMessageRequest } from '@a2a-js/sdk';

import type { A2APeerAttachRequest, A2APeerSendRequest, A2APeerTask } from './peer-client-types.ts';
import { PeerTaskTracker } from './peer-task-tracker.ts';
import { PeerTaskRun, type PeerTaskContext } from './peer-task.ts';

function userMessage(text: string, taskId: string, contextId: string, messageId: string): Message {
  return {
    messageId,
    contextId,
    taskId,
    role: Role.ROLE_USER,
    parts: [
      {
        content: { $case: 'text', value: text },
        metadata: undefined,
        filename: '',
        mediaType: 'text/plain',
      },
    ],
    metadata: undefined,
    extensions: [],
    referenceTaskIds: [],
  };
}

/** Refuses a send request whose fields are not what the types promise, before any request. */
export function assertSendRequest(request: A2APeerSendRequest): void {
  if (typeof request.text !== 'string') {
    throw new TypeError('A2APeerSendRequest.text must be a string.');
  }
  if (
    request.messageId !== undefined &&
    (typeof request.messageId !== 'string' || request.messageId === '')
  ) {
    throw new TypeError('A2APeerSendRequest.messageId must be a non-empty string.');
  }
}

/** Refuses an attach request that names no task, before any request. */
export function assertAttachRequest(request: A2APeerAttachRequest): void {
  if (typeof request.taskId !== 'string' || request.taskId === '') {
    throw new TypeError('A2APeerAttachRequest.taskId must be a non-empty string.');
  }
}

/**
 * Sends `request` to the peer and resolves with the task once the peer has named it. The
 * message identifier is fixed before the first attempt, so retrying a send that may have reached
 * the peer is the retry the A2A spec describes, not a second message. A caller-supplied
 * `messageId` extends that to a send repeated by a later process.
 */
export async function startPeerTask(
  context: PeerTaskContext,
  input: A2APeerSendRequest,
): Promise<A2APeerTask> {
  // The caller owns `input` and may change it while the first request is in flight.
  const request = { ...input };
  const tracker = new PeerTaskTracker(
    context.peer,
    request,
    context.artifactLimit,
    request.taskId !== undefined,
  );
  const run = new PeerTaskRun(context, tracker);
  const opening = openingRequest(context, request);
  return openTask(run, request.signal, () => run.open(opening));
}

/**
 * Follows a task the peer already holds, without sending a message. The first response is the
 * task's current state, so a task that has already stopped is returned stopped.
 */
export async function attachPeerTask(
  context: PeerTaskContext,
  input: A2APeerAttachRequest,
): Promise<A2APeerTask> {
  // The caller owns `input` and may change it while the first request is in flight.
  const request = { ...input };
  const taskId = request.taskId;
  const tracker = new PeerTaskTracker(
    context.peer,
    { text: '', taskId, contextId: request.contextId, onUpdate: request.onUpdate },
    context.artifactLimit,
    false,
  );
  const run = new PeerTaskRun(context, tracker);
  return openTask(run, request.signal, () => run.attach(taskId));
}

/**
 * Runs `open` and ties the task to `signal`: an abort before the task is open ends the request,
 * and one after it cancels the remote task.
 */
async function openTask(
  run: PeerTaskRun,
  signal: AbortSignal | undefined,
  open: () => Promise<void>,
): Promise<A2APeerTask> {
  if (signal === undefined) {
    await open();
    return run;
  }
  // Nothing is sent for a signal that has already aborted.
  signal.throwIfAborted();
  const onAbort = (): void => {
    if (run.hasOpened())
      void run.cancel(typeof signal.reason === 'string' ? signal.reason : undefined);
    else run.abortOpen();
  };
  signal.addEventListener('abort', onAbort, { once: true });
  run.onSettled(() => signal.removeEventListener('abort', onAbort));
  try {
    await open();
  } catch (error) {
    signal.removeEventListener('abort', onAbort);
    signal.throwIfAborted();
    throw error;
  }
  if (signal.aborted) onAbort();
  return run;
}

function openingRequest(context: PeerTaskContext, request: A2APeerSendRequest): SendMessageRequest {
  return {
    tenant: '',
    message: userMessage(
      request.text,
      request.taskId ?? '',
      request.contextId ?? '',
      request.messageId ?? crypto.randomUUID(),
    ),
    configuration: {
      acceptedOutputModes: [...context.acceptedOutputModes],
      taskPushNotificationConfig: undefined,
      historyLength: 0,
      returnImmediately: !context.streaming,
    },
    metadata: undefined,
  };
}
