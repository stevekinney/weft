import { readFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { readManifest } from './manifest.ts';
import { resolveFixtureRequest } from './route-contract.ts';

type FixtureServerOptions = {
  outputDirectory: string;
  manifestPath: string;
  port: number;
  development: boolean;
  waitForBuild?: () => Promise<void>;
};
type RenderPage = (url: string) => Promise<string>;

function response(
  status: number,
  body: string,
  contentType = 'text/plain; charset=utf-8',
): Response {
  return new Response(body, { status, headers: { 'content-type': contentType } });
}

export async function handleFixtureRequest(
  request: Request,
  manifestPath: string,
  renderPage: RenderPage,
): Promise<Response | undefined> {
  const url = new URL(request.url);
  const isPage = url.pathname.startsWith('/page/');
  if (!isPage && url.pathname !== '/ready' && url.pathname !== '/api/manifest') return undefined;
  let component: string;
  try {
    component = decodeURIComponent(url.pathname.slice('/page/'.length));
  } catch {
    return response(400, 'Invalid component URI.');
  }
  const manifest = readManifest(manifestPath);
  if (url.pathname === '/ready') return response(200, 'ready');
  if (url.pathname === '/api/manifest') return Response.json(manifest);
  const result = resolveFixtureRequest(
    manifest.entries,
    component,
    url.searchParams.get('fixture'),
    url.searchParams.get('fixtureContentHash'),
  );
  if ('status' in result) return response(result.status, result.message);
  const html = await renderPage(request.url);
  return response(
    200,
    html.replace(
      '<html lang="en">',
      `<html lang="en"${url.searchParams.get('snapshot') === '1' ? ' data-snapshot-mode=""' : ''}>`,
    ),
    'text/html; charset=utf-8',
  );
}

async function staticResponse(request: Request, outputDirectory: string): Promise<Response> {
  let pathname: string;
  try {
    pathname = decodeURIComponent(new URL(request.url).pathname);
  } catch {
    return response(400, 'Invalid asset path.');
  }
  const relativePath = pathname === '/' ? 'index.html' : pathname.slice(1);
  const filePath = resolve(outputDirectory, relativePath);
  if (!filePath.startsWith(`${resolve(outputDirectory)}${sep}`) || pathname.includes('\0')) {
    return response(400, 'Invalid asset path.');
  }
  const file = Bun.file(filePath);
  if (!(await file.exists())) return response(404, 'Not found.');
  return new Response(file);
}

export function createFixtureServer(options: FixtureServerOptions) {
  const renderPage = () => readFile(resolve(options.outputDirectory, 'index.html'), 'utf8');
  return Bun.serve({
    port: options.port,
    hostname: '127.0.0.1',
    development: options.development,
    async fetch(request) {
      await options.waitForBuild?.();
      return (
        (await handleFixtureRequest(request, options.manifestPath, renderPage)) ??
        staticResponse(request, options.outputDirectory)
      );
    },
    error(error) {
      process.stderr.write(`[fixture host] ${error.stack ?? error.message}\n`);
      return response(500, error.message);
    },
  });
}
