import { describe, expect, it } from 'bun:test';

import { decode } from '../../core/codec.ts';
import { negotiatedResponse } from './response-helpers.ts';

describe('negotiatedResponse', () => {
  it('returns JSON by default with the supplied status', async () => {
    const response = negotiatedResponse(
      new Request('http://localhost/v1/example'),
      { ok: true },
      202,
    );

    expect(response.status).toBe(202);
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(await response.json()).toEqual({ ok: true });
  });

  it('returns MessagePack when the Accept header contains application/msgpack', async () => {
    const response = negotiatedResponse(
      new Request('http://localhost/v1/example', {
        headers: { Accept: 'application/json, application/msgpack;q=0.5' },
      }),
      { ok: true },
      206,
    );

    expect(response.status).toBe(206);
    expect(response.headers.get('content-type')).toBe('application/msgpack');
    expect(decode(new Uint8Array(await response.arrayBuffer()))).toEqual({ ok: true });
  });
});
