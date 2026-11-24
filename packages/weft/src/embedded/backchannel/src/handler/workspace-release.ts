import type { Principal, WorkspaceIdentity } from '../principal.ts';
import type { OperationHandlerAuthenticate } from './operation-handler-authentication.ts';

function retainsWorkspaceAuthority(
  original: WorkspaceIdentity,
  current: WorkspaceIdentity,
): boolean {
  return (
    current.workspaceId === original.workspaceId &&
    current.actorId === original.actorId &&
    current.owner === original.owner &&
    current.actorKind === original.actorKind &&
    current.capabilities.includes('workspace:use') &&
    original.capabilities.every((capability) => current.capabilities.includes(capability))
  );
}

/** Recheck a workspace connection without allowing a credential to change its identity. */
export function createWorkspaceRevalidation(
  authenticate: OperationHandlerAuthenticate | undefined,
  request: Request,
  principal: Principal,
): (() => Promise<boolean>) | undefined {
  if (
    authenticate === undefined ||
    principal.method === 'unauthenticated' ||
    principal.workspace === undefined
  )
    return undefined;
  const original = structuredClone(principal.workspace);
  const method = principal.method;
  const subject = principal.subject;
  const scopes = [...principal.scopes];
  return async () => {
    try {
      const context = await authenticate(request);
      if (context instanceof Response) return false;
      const current = context.principal;
      const workspace = current?.workspace;
      return (
        current !== undefined &&
        workspace !== undefined &&
        current.method === method &&
        current.subject === subject &&
        retainsWorkspaceAuthority(original, workspace) &&
        scopes.every((scope) => current.hasScope(scope))
      );
    } catch {
      return false;
    }
  };
}

/** Check immediately before returning a response and before releasing each buffered body chunk. */
export async function guardWorkspaceResponse(
  response: Response,
  revalidate: (() => Promise<boolean>) | undefined,
): Promise<Response> {
  if (revalidate === undefined) return response;
  if (!(await revalidate())) {
    await response.body?.cancel();
    return new Response('Workspace membership required', { status: 403 });
  }
  if (response.body === null) return response;
  const reader = response.body.getReader();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const frame = await reader.read();
      if (frame.done) {
        controller.close();
        return;
      }
      if (!(await revalidate())) {
        await reader.cancel();
        controller.close();
        return;
      }
      controller.enqueue(frame.value);
    },
    cancel: (reason) => reader.cancel(reason),
  });
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}
