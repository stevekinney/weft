import { MemoryStorage } from "../embedded/storage/src/index.ts";
import { Engine } from '../core/engine.ts';
import { workflow } from '../core/types.ts';
import {
  createMcpEndpoint,
  handleMcpHttpRequest,
  McpEndpoint,
  type McpHttpRequestOptions,
  type McpStdioSessionOptions,
} from './index.ts';

const greet = workflow({ name: 'greet' }).execute(async function* (_ctx, input: { a: number }) {
  return { b: input.a };
});

// Regression guard for #708 (sibling of `ServeOptions.engine`):
// `McpEndpoint`, `createMcpEndpoint`, and `McpStdioSessionOptions` must all
// accept BOTH `new Engine({ storage })`
// (the default, empty registry) and `Engine.create({ workflows })` (a
// concretely narrowed, non-empty registry) without a call-site cast.
async function verifyMcpSurfacesAcceptBothEngineConstructionPatterns(): Promise<void> {
  const defaultEngine = new Engine({ storage: new MemoryStorage() });
  const concreteEngine = await Engine.create({
    storage: new MemoryStorage(),
    workflows: { greet },
  });

  const defaultEndpoint = new McpEndpoint(defaultEngine);
  const concreteEndpoint = new McpEndpoint(concreteEngine);
  void defaultEndpoint;
  void concreteEndpoint;

  const defaultCreatedEndpoint = createMcpEndpoint(defaultEngine);
  const concreteCreatedEndpoint = createMcpEndpoint(concreteEngine);

  const defaultHttpOptions: McpHttpRequestOptions = {
    request: new Request('http://localhost/mcp'),
    endpoint: defaultCreatedEndpoint,
    authRequired: false,
  };
  const concreteHttpOptions: McpHttpRequestOptions = {
    request: new Request('http://localhost/mcp'),
    endpoint: concreteCreatedEndpoint,
    authRequired: false,
  };
  void handleMcpHttpRequest(defaultHttpOptions);
  void handleMcpHttpRequest(concreteHttpOptions);

  const defaultStdioOptions: McpStdioSessionOptions = {
    input: new ReadableStream<Uint8Array>(),
    output: new WritableStream<Uint8Array>(),
    engine: defaultEngine,
    admission: { kind: 'require-one' },
  };
  const concreteStdioOptions: McpStdioSessionOptions = {
    input: new ReadableStream<Uint8Array>(),
    output: new WritableStream<Uint8Array>(),
    engine: concreteEngine,
    admission: { kind: 'require-one' },
  };
  void defaultStdioOptions;
  void concreteStdioOptions;
}
void verifyMcpSurfacesAcceptBothEngineConstructionPatterns;
