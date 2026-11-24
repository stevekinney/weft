/**
 * An in-process S3-compatible object store for tests of code that talks to S3.
 *
 * It answers path-style `GET`, `HEAD`, `PUT`, and `DELETE` on objects and ListObjectsV2 on the
 * bucket, with the statuses the COR-1759 probe recorded from a real store. It never checks a
 * signature: a header-signed request (`Authorization`) and a presigned one (`X-Amz-*` query
 * parameters) are both accepted, and so is an unsigned one. That makes it a protocol double, not a
 * security boundary, so it binds loopback only.
 */

/** The most keys one ListObjectsV2 page holds, which is also S3's own limit. */
export const S3_LIST_PAGE_SIZE = 1000;

const BUCKET_REGION = 'us-east-1';
const ACCESS_KEY_ID = 'test-access-key-id';
const SECRET_ACCESS_KEY = 'test-secret-access-key';

interface StoredObject {
  readonly bytes: Uint8Array;
  readonly etag: string;
  readonly lastModified: Date;
  readonly contentType: string;
}

/** The options that make a `Bun.S3Client` talk to an {@link S3TestServer}. */
export interface S3TestServerClientOptions {
  /** The server's base URL, `http://127.0.0.1:<port>`. */
  readonly endpoint: string;
  /** The only bucket the server answers for. */
  readonly bucket: string;
  /** A region name; the server does not read it. */
  readonly region: string;
  /** A credential; the server does not check it. */
  readonly accessKeyId: string;
  /** A credential; the server does not check it. */
  readonly secretAccessKey: string;
}

/** What {@link createS3TestServer} accepts. */
export interface S3TestServerOptions {
  /** The bucket to serve. Defaults to `test-bucket`. A request for any other bucket is a 404. */
  readonly bucket?: string;
}

/** A running in-process S3-compatible server. Dispose it with `await using`. */
export interface S3TestServer {
  /** The loopback address the server is bound to, always `127.0.0.1`. */
  readonly hostname: string;
  /** The ephemeral port the operating system assigned. */
  readonly port: number;
  /** The server's base URL, `http://127.0.0.1:<port>`. */
  readonly endpoint: string;
  /** The only bucket the server answers for. */
  readonly bucket: string;
  /** Options for `new Bun.S3Client(...)`. Path-style addressing is the only style the server answers. */
  clientOptions(): S3TestServerClientOptions;
  /**
   * A snapshot of the bucket: key to a copy of the bytes. Changing the returned map or its
   * arrays does not change the bucket; use {@link S3TestServer.put} for that.
   */
  objects(): Map<string, Uint8Array>;
  /**
   * Store an object directly, bypassing every request condition, and return its quoted ETag.
   * Replaces an existing object of the same key.
   */
  put(key: string, bytes: Uint8Array | string, contentType?: string): string;
  /** Stop listening and drop open connections. Safe to call more than once. */
  stop(): Promise<void>;
  /** Same as {@link S3TestServer.stop}, so `await using` disposes the server. */
  [Symbol.asyncDispose](): Promise<void>;
}

function quotedEtag(bytes: Uint8Array): string {
  return `"${new Bun.CryptoHasher('md5').update(bytes).digest('hex')}"`;
}

function escapeXml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function xmlResponse(status: number, body: string, headers: Record<string, string> = {}): Response {
  return new Response(`<?xml version="1.0" encoding="UTF-8"?>\n${body}`, {
    status,
    headers: { 'content-type': 'application/xml', ...headers },
  });
}

function errorResponse(
  status: number,
  code: string,
  message: string,
  method: string,
  resource: string,
): Response {
  // A HEAD response has no body, and the probe recorded the same for a missing key.
  if (method === 'HEAD') return new Response(null, { status });
  return xmlResponse(
    status,
    `<Error><Code>${code}</Code><Message>${escapeXml(message)}</Message><Resource>${escapeXml(resource)}</Resource></Error>`,
  );
}

/** The ETags named by an `If-Match` or `If-None-Match` header value. */
function conditionTags(value: string): readonly string[] {
  return value.split(',').map((tag) => tag.trim());
}

function tagsMatch(header: string, etag: string): boolean {
  const tags = conditionTags(header);
  return tags.includes('*') || tags.includes(etag) || tags.includes(`W/${etag}`);
}

/**
 * Evaluate a request's conditions against the stored object, or `null` when the object is absent.
 * Returns the failing response, or `null` when the request may proceed. `If-Match` is evaluated
 * first, as RFC 9110 orders it; an absent object under `If-Match` is a 404, as the probe recorded.
 */
function failedCondition(
  request: Request,
  existing: StoredObject | undefined,
  resource: string,
): Response | null {
  const { method, headers } = request;
  const ifMatch = headers.get('if-match');
  const ifNoneMatch = headers.get('if-none-match');
  if (ifMatch !== null) {
    if (existing === undefined)
      return errorResponse(404, 'NoSuchKey', 'The specified key does not exist.', method, resource);
    if (!tagsMatch(ifMatch, existing.etag))
      return errorResponse(
        412,
        'PreconditionFailed',
        'At least one of the pre-conditions you specified did not hold.',
        method,
        resource,
      );
  }
  if (ifNoneMatch !== null && existing !== undefined && tagsMatch(ifNoneMatch, existing.etag)) {
    // A read answers 304; a write is refused with 412, which is what S3 does for `If-None-Match: *`.
    if (method === 'GET' || method === 'HEAD')
      return new Response(null, { status: 304, headers: { etag: existing.etag } });
    return errorResponse(
      412,
      'PreconditionFailed',
      'At least one of the pre-conditions you specified did not hold.',
      method,
      resource,
    );
  }
  return null;
}

function objectHeaders(object: StoredObject): Record<string, string> {
  return {
    etag: object.etag,
    'content-length': String(object.bytes.byteLength),
    'content-type': object.contentType,
    'last-modified': object.lastModified.toUTCString(),
    'accept-ranges': 'bytes',
  };
}

function noSuchKey(method: string, resource: string): Response {
  return errorResponse(404, 'NoSuchKey', 'The specified key does not exist.', method, resource);
}

function readObject(request: Request, existing: StoredObject | undefined, key: string): Response {
  const resource = `/${key}`;
  const refused = failedCondition(request, existing, resource);
  if (refused !== null) return refused;
  if (existing === undefined) return noSuchKey(request.method, resource);
  const headers = objectHeaders(existing);
  if (request.method === 'HEAD') return new Response(null, { status: 200, headers });
  return new Response(existing.bytes.slice(), { status: 200, headers });
}

function encodeContinuationToken(lastKey: string): string {
  return Buffer.from(lastKey, 'utf8').toString('base64url');
}

function decodeContinuationToken(token: string): string | null {
  if (!/^[A-Za-z0-9_-]*$/.test(token)) return null;
  return Buffer.from(token, 'base64url').toString('utf8');
}

function parseMaxKeys(value: string | null): number | null {
  if (value === null) return S3_LIST_PAGE_SIZE;
  if (!/^\d+$/.test(value)) return null;
  return Math.min(Number(value), S3_LIST_PAGE_SIZE);
}

function listObjects(
  store: ReadonlyMap<string, StoredObject>,
  bucket: string,
  query: URLSearchParams,
): Response {
  const resource = `/${bucket}`;
  const prefix = query.get('prefix') ?? '';
  const maxKeys = parseMaxKeys(query.get('max-keys'));
  if (maxKeys === null)
    return errorResponse(
      400,
      'InvalidArgument',
      'Provided max-keys not an integer or within integer range.',
      'GET',
      resource,
    );
  const token = query.get('continuation-token');
  let after = query.get('start-after') ?? '';
  if (token !== null && token !== '') {
    const decoded = decodeContinuationToken(token);
    if (decoded === null)
      return errorResponse(
        400,
        'InvalidArgument',
        'The continuation token provided is incorrect.',
        'GET',
        resource,
      );
    after = decoded;
  }
  const matching = [...store.keys()]
    .filter((key) => key.startsWith(prefix) && (after === '' || key > after))
    .toSorted();
  const page = matching.slice(0, maxKeys);
  const truncated = matching.length > page.length;
  const contents = page
    .map((key) => {
      const object = store.get(key);
      if (object === undefined) return '';
      return `<Contents><Key>${escapeXml(key)}</Key><LastModified>${object.lastModified.toISOString()}</LastModified><ETag>${escapeXml(object.etag)}</ETag><Size>${object.bytes.byteLength}</Size><StorageClass>STANDARD</StorageClass></Contents>`;
    })
    .join('');
  const continuation =
    truncated && page.length > 0
      ? `<NextContinuationToken>${encodeContinuationToken(page[page.length - 1] ?? '')}</NextContinuationToken>`
      : '';
  return xmlResponse(
    200,
    `<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>${escapeXml(bucket)}</Name><Prefix>${escapeXml(prefix)}</Prefix><KeyCount>${page.length}</KeyCount><MaxKeys>${maxKeys}</MaxKeys><IsTruncated>${truncated}</IsTruncated>${continuation}${contents}</ListBucketResult>`,
  );
}

/**
 * Write an object. The body is read before any condition is evaluated, and the condition check
 * and the store write then run with no `await` between them. Reading the body second would let two
 * `If-None-Match: *` writes both observe an absent key and both succeed.
 */
async function writeObject(
  store: Map<string, StoredObject>,
  request: Request,
  key: string,
): Promise<Response> {
  const bytes = new Uint8Array(await request.arrayBuffer());
  const resource = `/${key}`;
  const refused = failedCondition(request, store.get(key), resource);
  if (refused !== null) return refused;
  const etag = quotedEtag(bytes);
  store.set(key, {
    bytes,
    etag,
    lastModified: new Date(),
    contentType: request.headers.get('content-type') ?? 'application/octet-stream',
  });
  return new Response(null, { status: 200, headers: { etag } });
}

function deleteObject(store: Map<string, StoredObject>, request: Request, key: string): Response {
  const existing = store.get(key);
  const resource = `/${key}`;
  const refused = failedCondition(request, existing, resource);
  if (refused !== null) return refused;
  store.delete(key);
  return new Response(null, { status: 204 });
}

function parseTarget(
  url: URL,
  bucket: string,
): { readonly key: string | null } | { readonly error: Response } {
  const segments = url.pathname.split('/');
  // `/bucket` and `/bucket/` address the bucket; `/bucket/a/b` addresses the key `a/b`.
  const requested = segments[1] ?? '';
  let name: string;
  let key: string;
  try {
    name = decodeURIComponent(requested);
    key = decodeURIComponent(segments.slice(2).join('/'));
  } catch {
    return {
      error: errorResponse(
        400,
        'InvalidURI',
        "Couldn't parse the specified URI.",
        'GET',
        url.pathname,
      ),
    };
  }
  if (name !== bucket)
    return {
      error: errorResponse(
        404,
        'NoSuchBucket',
        'The specified bucket does not exist.',
        'GET',
        `/${requested}`,
      ),
    };
  return { key: key === '' ? null : key };
}

async function handle(
  store: Map<string, StoredObject>,
  bucket: string,
  request: Request,
): Promise<Response> {
  const url = new URL(request.url);
  const target = parseTarget(url, bucket);
  if ('error' in target) return target.error;
  const { method } = request;
  const { key } = target;
  if (key === null) {
    if (method === 'GET' && url.searchParams.get('list-type') === '2')
      return listObjects(store, bucket, url.searchParams);
    return errorResponse(
      501,
      'NotImplemented',
      'Only ListObjectsV2 is implemented on the bucket.',
      method,
      url.pathname,
    );
  }
  if (method === 'GET' || method === 'HEAD') return readObject(request, store.get(key), key);
  if (method === 'PUT') return writeObject(store, request, key);
  if (method === 'DELETE') return deleteObject(store, request, key);
  return errorResponse(
    405,
    'MethodNotAllowed',
    'The specified method is not allowed against this resource.',
    method,
    url.pathname,
  );
}

/**
 * Start an S3-compatible server on `127.0.0.1` and an ephemeral port.
 *
 * Statuses follow the COR-1759 probe: a conditional `PUT` or `DELETE` with a stale `If-Match`
 * or an existing key under `If-None-Match` is `412 PreconditionFailed`; `If-Match` on an absent
 * key is `404 NoSuchKey`; a `DELETE` of an absent key is `204`. ETags are quoted MD5 digests and
 * round-trip verbatim into `If-Match`. Listing pages at {@link S3_LIST_PAGE_SIZE} keys with
 * `NextContinuationToken`. `Bun.S3Client.write` cannot send a condition, so a test of a conditional
 * write signs with `client.presign(...)` and sends the header with `fetch`.
 */
export function createS3TestServer(options: S3TestServerOptions = {}): S3TestServer {
  const bucket = options.bucket ?? 'test-bucket';
  if (bucket === '' || bucket.includes('/'))
    throw new TypeError(`An S3 test server needs a bucket name without slashes, got "${bucket}".`);
  const store = new Map<string, StoredObject>();
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: (request) => handle(store, bucket, request),
  });
  const hostname = server.hostname ?? '127.0.0.1';
  const port = server.port ?? 0;
  const endpoint = `http://${hostname}:${port}`;
  const stop = async (): Promise<void> => {
    await server.stop(true);
  };
  return {
    hostname,
    port,
    endpoint,
    bucket,
    clientOptions: () => ({
      endpoint,
      bucket,
      region: BUCKET_REGION,
      accessKeyId: ACCESS_KEY_ID,
      secretAccessKey: SECRET_ACCESS_KEY,
    }),
    objects: () => new Map([...store].map(([key, object]) => [key, object.bytes.slice()])),
    put: (key, bytes, contentType = 'application/octet-stream') => {
      const copy = typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes.slice();
      const etag = quotedEtag(copy);
      store.set(key, { bytes: copy, etag, lastModified: new Date(), contentType });
      return etag;
    },
    stop,
    [Symbol.asyncDispose]: stop,
  };
}
