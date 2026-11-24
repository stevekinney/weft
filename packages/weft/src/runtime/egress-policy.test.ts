import { afterEach, describe, expect, test } from 'bun:test';

import { createEgressPolicy, type EgressDecision } from './egress-policy.ts';
import { setPortableRuntimeTestOverridesForTesting } from './portable.ts';

afterEach(() => {
  setPortableRuntimeTestOverridesForTesting(undefined);
});

/** A resolver that answers every hostname with `addresses`. */
function resolvingTo(...addresses: string[]) {
  return async () => addresses;
}

function expectBlocked(decision: EgressDecision, reason: RegExp): void {
  expect(decision.status).toBe('blocked');
  if (decision.status === 'blocked') expect(decision.reason).toMatch(reason);
}

const neverResolve = async (): Promise<readonly string[]> => {
  throw new Error('The resolver must not be consulted for an IP literal.');
};

describe('createEgressPolicy scheme check', () => {
  test('rejects an http URL unless allowInsecureHttp is set', async () => {
    const strict = createEgressPolicy({ resolveHost: resolvingTo('93.184.216.34') });
    expectBlocked(await strict.check('http://hooks.example.com/'), /http: scheme/);

    const relaxed = createEgressPolicy({
      allowInsecureHttp: true,
      resolveHost: resolvingTo('93.184.216.34'),
    });
    expect(await relaxed.check('http://hooks.example.com/')).toMatchObject({ status: 'allowed' });
  });

  test('rejects every other scheme, even with allowInsecureHttp', async () => {
    const policy = createEgressPolicy({ allowInsecureHttp: true });
    expectBlocked(await policy.check('ftp://93.184.216.34/'), /ftp: scheme/);
    expectBlocked(await policy.check('file:///etc/passwd'), /file: scheme/);
  });

  test('rejects a string that is not a URL', async () => {
    expectBlocked(await createEgressPolicy().check('not a url'), /not a valid URL/);
  });

  test('allows a public https address and returns the parsed URL', async () => {
    const decision = await createEgressPolicy({
      resolveHost: resolvingTo('93.184.216.34', '2606:2800:220:1:248:1893:25c8:1946'),
    }).check(new URL('https://hooks.example.com/a2a'));
    expect(decision).toEqual({ status: 'allowed', url: new URL('https://hooks.example.com/a2a') });
  });
});

describe('createEgressPolicy blocks every non-public range, as a literal and when resolved', () => {
  const cases: ReadonlyArray<readonly [label: string, address: string, reason: RegExp]> = [
    ['IPv4 loopback 127.0.0.0/8', '127.0.0.1', /loopback \(127\.0\.0\.0\/8\)/],
    ['the top of 127.0.0.0/8', '127.255.255.254', /loopback/],
    ['IPv6 loopback ::1', '::1', /loopback \(::1\/128\)/],
    ['this network 0.0.0.0/8', '0.0.0.0', /this network \(0\.0\.0\.0\/8\)/],
    ['RFC 1918 10.0.0.0/8', '10.1.2.3', /private \(10\.0\.0\.0\/8\)/],
    ['RFC 1918 172.16.0.0/12', '172.31.255.255', /private \(172\.16\.0\.0\/12\)/],
    ['RFC 1918 192.168.0.0/16', '192.168.1.1', /private \(192\.168\.0\.0\/16\)/],
    ['IPv4 link-local 169.254.0.0/16', '169.254.169.254', /link-local \(169\.254\.0\.0\/16\)/],
    ['IPv6 link-local fe80::/10', 'fe80::1', /link-local \(fe80::\/10\)/],
    ['the top of fe80::/10', 'febf:ffff::1', /link-local/],
    ['unique-local fc00::/7', 'fd12:3456:789a::1', /unique-local \(fc00::\/7\)/],
    ['the bottom of fc00::/7', 'fc00::1', /unique-local/],
    ['CGNAT 100.64.0.0/10', '100.100.100.200', /carrier-grade NAT \(100\.64\.0\.0\/10\)/],
    ['IPv4 multicast 224.0.0.0/4', '239.255.255.250', /multicast \(224\.0\.0\.0\/4\)/],
    ['IPv6 multicast ff00::/8', 'ff02::1', /multicast \(ff00::\/8\)/],
    ['reserved 240.0.0.0/4', '240.0.0.1', /reserved \(240\.0\.0\.0\/4\)/],
    ['the broadcast address in 240.0.0.0/4', '255.255.255.255', /reserved/],
    ['IPv6 unspecified ::', '::', /unspecified \(::\/128\)/],
    [
      'IETF protocol assignments 192.0.0.0/24',
      '192.0.0.8',
      /IETF protocol assignments \(192\.0\.0\.0\/24\)/,
    ],
    ['documentation 192.0.2.0/24', '192.0.2.1', /documentation \(192\.0\.2\.0\/24\)/],
    ['benchmarking 198.18.0.0/15', '198.18.0.1', /benchmarking \(198\.18\.0\.0\/15\)/],
    ['the top of 198.18.0.0/15', '198.19.255.254', /benchmarking/],
    ['documentation 198.51.100.0/24', '198.51.100.7', /documentation \(198\.51\.100\.0\/24\)/],
    ['documentation 203.0.113.0/24', '203.0.113.9', /documentation \(203\.0\.113\.0\/24\)/],
    ['local-use NAT64 64:ff9b:1::/48', '64:ff9b:1::a00:1', /local-use NAT64 \(64:ff9b:1::\/48\)/],
    ['discard-only 100::/64', '100::1', /discard-only \(100::\/64\)/],
    [
      'IETF protocol assignments 2001::/23',
      '2001:1ff::1',
      /IETF protocol assignments \(2001::\/23\)/,
    ],
    ['Teredo in 2001::/23', '2001:0:4136:e378:8000:63bf:3fff:fdd2', /IETF protocol assignments/],
    ['documentation 2001:db8::/32', '2001:db8::1', /documentation \(2001:db8::\/32\)/],
    ['6to4 2002::/16', '2002:7f00:1::1', /6to4 \(2002::\/16\)/],
    ['documentation 3fff::/20', '3fff:fff::1', /documentation \(3fff::\/20\)/],
    ['SRv6 SIDs 5f00::/16', '5f00::1', /SRv6 SIDs \(5f00::\/16\)/],
    ['IPv4-mapped benchmarking', '::ffff:198.18.0.1', /benchmarking .* in IPv4-mapped \(/],
    ['IPv4-mapped documentation', '::ffff:192.0.2.1', /documentation .* in IPv4-mapped \(/],
    [
      'IPv4-mapped IETF protocol assignments',
      '::ffff:192.0.0.8',
      /IETF protocol assignments .* in IPv4-mapped \(/,
    ],
    ['IPv4-mapped loopback', '::ffff:127.0.0.1', /loopback .* in IPv4-mapped \(/],
    ['IPv4-mapped loopback in hex', '::ffff:7f00:1', /loopback .* in IPv4-mapped \(/],
    ['IPv4-mapped RFC 1918', '::ffff:10.0.0.1', /private .* in IPv4-mapped \(/],
    ['IPv4-mapped link-local', '::ffff:169.254.169.254', /link-local .* in IPv4-mapped \(/],
    ['IPv4-mapped CGNAT', '::ffff:100.64.0.1', /carrier-grade NAT .* in IPv4-mapped \(/],
    ['IPv4-mapped this network', '::ffff:0.0.0.0', /this network .* in IPv4-mapped \(/],
    ['IPv4-mapped multicast', '::ffff:224.0.0.1', /multicast .* in IPv4-mapped \(/],
    ['IPv4-mapped reserved', '::ffff:240.0.0.1', /reserved .* in IPv4-mapped \(/],
    ['IPv4-translated loopback', '::ffff:0:127.0.0.1', /loopback .* in IPv4-translated \(/],
    ['NAT64 loopback', '64:ff9b::127.0.0.1', /loopback .* in NAT64 \(/],
    ['IPv4-compatible loopback', '::127.0.0.1', /loopback .* in IPv4-compatible \(/],
  ];

  for (const [label, address, reason] of cases) {
    test(`${label} as a URL literal`, async () => {
      const host = address.includes(':') ? `[${address}]` : address;
      const policy = createEgressPolicy({ resolveHost: neverResolve });
      expectBlocked(await policy.check(`https://${host}/hook`), reason);
    });

    test(`${label} behind a hostname`, async () => {
      const policy = createEgressPolicy({ resolveHost: resolvingTo(address) });
      expectBlocked(await policy.check('https://hooks.example.com/hook'), reason);
    });
  }

  test('URL normalization cannot smuggle loopback past the check', async () => {
    const policy = createEgressPolicy({ resolveHost: neverResolve });
    for (const host of ['0x7f.1', '2130706433', '127.1', '[0:0:0:0:0:0:0:1]', '[::ffff:7f00:1]']) {
      expectBlocked(await policy.check(`https://${host}/`), /loopback/);
    }
  });

  test('a hostname is blocked when any one of its addresses is non-public', async () => {
    const policy = createEgressPolicy({ resolveHost: resolvingTo('93.184.216.34', '10.0.0.5') });
    expectBlocked(
      await policy.check('https://hooks.example.com/'),
      /resolves to 10\.0\.0\.5, private/,
    );
  });

  test('addresses next to the blocked ranges are allowed', async () => {
    const policy = createEgressPolicy({
      resolveHost: resolvingTo(
        '1.0.0.1',
        '11.0.0.1',
        '100.63.255.255',
        '100.128.0.1',
        '126.255.255.255',
        '128.0.0.1',
        '169.253.255.255',
        '172.15.255.255',
        '172.32.0.1',
        '192.167.255.255',
        '192.169.0.1',
        '192.0.1.255',
        '192.0.3.0',
        '198.17.255.255',
        '198.20.0.1',
        '198.51.99.255',
        '198.51.101.0',
        '203.0.112.255',
        '203.0.114.0',
        '223.255.255.255',
        'fec0::1',
        'fbff::1',
        '64:ff9b:2::1',
        '100:0:0:1::1',
        '2001:200::1',
        '2001:db9::1',
        '2003::1',
        '3fff:1000::1',
        '5f01::1',
        '::ffff:93.184.216.34',
        '64:ff9b::93.184.216.34',
      ),
    });
    expect(await policy.check('https://hooks.example.com/')).toMatchObject({ status: 'allowed' });
    const literal = createEgressPolicy({ resolveHost: neverResolve });
    expect(await literal.check('https://[2606:4700::1111]/')).toMatchObject({ status: 'allowed' });
  });

  test('a resolver answer that is not an IP address is blocked', async () => {
    for (const answer of [
      'not-an-address',
      '1.2.3',
      '1.2.3.256',
      '1::2::3',
      '1:2:3:4:5:6:7:8:9',
      'g::1',
      '1:2:3',
    ]) {
      const policy = createEgressPolicy({ resolveHost: resolvingTo(answer) });
      expectBlocked(await policy.check('https://hooks.example.com/'), /not an IP address/);
    }
  });

  test('a zone index on a resolved link-local address does not hide it', async () => {
    const policy = createEgressPolicy({ resolveHost: resolvingTo('fe80::1%en0') });
    expectBlocked(await policy.check('https://hooks.example.com/'), /link-local/);
  });
});

describe('createEgressPolicy resolution', () => {
  test('a resolver failure is unresolved, not blocked, so a later attempt may succeed', async () => {
    const policy = createEgressPolicy({
      resolveHost: async () => {
        throw Object.assign(new Error('getaddrinfo ENOTFOUND hooks.example.com'), {
          code: 'ENOTFOUND',
        });
      },
    });
    const decision = await policy.check('https://hooks.example.com/');
    expect(decision.status).toBe('unresolved');
    if (decision.status === 'unresolved') expect(decision.reason).toMatch(/ENOTFOUND/);
  });

  test('a resolver failure that is not an Error is still described', async () => {
    const policy = createEgressPolicy({
      resolveHost: async () => {
        throw 'temporary failure';
      },
    });
    expect(await policy.check('https://hooks.example.com/')).toEqual({
      status: 'unresolved',
      reason: 'hooks.example.com did not resolve: temporary failure',
    });
  });

  test('a hostname that resolves to nothing is unresolved', async () => {
    const decision = await createEgressPolicy({ resolveHost: resolvingTo() }).check(
      'https://hooks.example.com/',
    );
    expect(decision).toEqual({
      status: 'unresolved',
      reason: 'hooks.example.com resolved to no addresses.',
    });
  });

  test('with no resolver, a hostname not on the allowlist is rejected', async () => {
    const decision = await createEgressPolicy({ resolveHost: null }).check(
      'https://hooks.example.com/',
    );
    expectBlocked(decision, /No resolver is available/);
  });

  test('with no resolver, a public IP literal still passes', async () => {
    const decision = await createEgressPolicy({ resolveHost: null }).check(
      'https://93.184.216.34/',
    );
    expect(decision.status).toBe('allowed');
  });

  test('where the runtime offers no node:dns, the default resolver is absent', async () => {
    setPortableRuntimeTestOverridesForTesting({ process: undefined });
    expectBlocked(
      await createEgressPolicy().check('https://hooks.example.com/'),
      /No resolver is available/,
    );
  });

  test('the default resolver uses node:dns and blocks localhost', async () => {
    expectBlocked(await createEgressPolicy().check('https://localhost/'), /loopback/);
  });
});

describe('createEgressPolicy allowlist', () => {
  test('an exact host:port entry bypasses the range check', async () => {
    const policy = createEgressPolicy({
      allowInsecureHttp: true,
      allowlist: ['127.0.0.1:8080', '[::1]:8443', 'Localhost:3000'],
      resolveHost: neverResolve,
    });
    expect(await policy.check('http://127.0.0.1:8080/hook')).toMatchObject({ status: 'allowed' });
    expect(await policy.check('https://[::1]:8443/hook')).toMatchObject({ status: 'allowed' });
    expect(await policy.check('http://localhost:3000/hook')).toMatchObject({ status: 'allowed' });
  });

  test('a different port, or the same host on its default port, is still checked', async () => {
    const policy = createEgressPolicy({
      allowInsecureHttp: true,
      allowlist: ['127.0.0.1:8080'],
      resolveHost: neverResolve,
    });
    expectBlocked(await policy.check('http://127.0.0.1:8081/'), /loopback/);
    expectBlocked(await policy.check('http://127.0.0.1/'), /loopback/);
  });

  test('a default port matches an entry that names it', async () => {
    const policy = createEgressPolicy({
      allowlist: ['127.0.0.1:443'],
      resolveHost: neverResolve,
    });
    expect(await policy.check('https://127.0.0.1/')).toMatchObject({ status: 'allowed' });
  });

  test('the allowlist does not bypass the scheme check', async () => {
    const policy = createEgressPolicy({ allowlist: ['127.0.0.1:8080'] });
    expectBlocked(await policy.check('http://127.0.0.1:8080/'), /http: scheme/);
  });

  test('an allowlisted hostname is never resolved', async () => {
    const policy = createEgressPolicy({ allowlist: ['hooks.internal:443'], resolveHost: null });
    expect(await policy.check('https://hooks.internal/')).toMatchObject({ status: 'allowed' });
  });

  test('rejects an entry that is not an exact host:port pair', () => {
    for (const entry of [
      '127.0.0.1',
      'hooks.example.com',
      '127.0.0.1:80/path',
      'user@host:80',
      ' :80',
      '[::1:80',
    ]) {
      expect(() => createEgressPolicy({ allowlist: [entry] })).toThrow(TypeError);
    }
  });
});
