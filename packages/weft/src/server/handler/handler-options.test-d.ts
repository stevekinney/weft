import { Engine } from '../../core/engine.ts';
import { workflow } from '../../core/types.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { handleRequest } from '../handler.ts';

const greet = workflow({ name: 'greet' }).execute(async function* (_ctx, input: { a: number }) {
  return { b: input.a };
});

// Copilot review on #708 (PR #715): `handleRequest`'s `engine` parameter is
// widened to `RegistryAgnosticEngine` (see its JSDoc / #708), like the other
// host-facing surfaces this PR touches (`ServeOptions`, the service-worker
// options, the MCP surfaces). Pin the same "both `new Engine({ storage })`
// and `Engine.create({ workflows })` are accepted without a call-site cast"
// invariant here for symmetry, since `handleRequest` is public from both the
// package root (`@lostgradient/weft`) and the `@lostgradient/weft/server/handler`
// subpath.
async function verifyHandleRequestAcceptsBothEngineConstructionPatterns(): Promise<void> {
  const defaultEngine = new Engine({ storage: new MemoryStorage() });
  const concreteEngine = await Engine.create({
    storage: new MemoryStorage(),
    workflows: { greet },
  });

  void handleRequest(new Request('http://localhost/v1/health'), defaultEngine);
  void handleRequest(new Request('http://localhost/v1/health'), concreteEngine);
}
void verifyHandleRequestAcceptsBothEngineConstructionPatterns;
