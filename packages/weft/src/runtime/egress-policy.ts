/**
 * `createEgressPolicy`: decide, before any request leaves the process, whether an
 * outbound URL may be contacted. A webhook URL is caller-supplied, so without this
 * check a caller could point a delivery at the host's own loopback services, the
 * cloud metadata endpoint, or the private network behind it (server-side request
 * forgery).
 *
 * The policy requires `https` (unless `allowInsecureHttp` is set), then rejects a
 * host whose address — the literal in the URL, or every address its name resolves
 * to — falls in a range the IANA special-purpose address registries mark as not
 * globally reachable (loopback, private, link-local, unique-local, carrier-grade NAT,
 * protocol assignments, documentation, benchmarking, discard, 6to4, SRv6, local-use
 * NAT64, reserved, unspecified) or in multicast, including the IPv6 forms that embed
 * an IPv4 address. An `allowlist` of exact `host:port` pairs bypasses the range check.
 *
 * The check cannot pin the connection: `fetch` resolves the name again, so a
 * DNS-rebinding window remains between check and connection. Strict egress needs an
 * egress proxy.
 *
 * @module runtime/egress-policy
 */

import { tryLoadNodeBuiltin } from './portable.ts';

/** Resolve a hostname to every address it names, as IPv4 or IPv6 text. */
export type EgressHostResolver = (hostname: string) => Promise<readonly string[]>;

/** Options for {@link createEgressPolicy}. */
export type EgressPolicyOptions = {
  /** Permit `http:` URLs. Default `false`: only `https:` is contacted. */
  readonly allowInsecureHttp?: boolean | undefined;
  /**
   * Exact `host:port` pairs (`127.0.0.1:8080`, `[::1]:8443`, `hooks.internal:443`) that
   * bypass the address-range check, for loopback receivers in tests and development.
   * The scheme check still applies.
   */
  readonly allowlist?: readonly string[] | undefined;
  /**
   * How a hostname becomes addresses. Defaults to `node:dns` `lookup` where the
   * runtime provides it; `null` means no resolver. Without one, a hostname that is
   * not an IP literal and not on the allowlist is rejected.
   */
  readonly resolveHost?: EgressHostResolver | null | undefined;
};

/**
 * What {@link EgressPolicy.check} decided. `blocked` is permanent for this URL;
 * `unresolved` means its name could not be resolved right now, so nothing was sent and
 * a later attempt may succeed.
 */
export type EgressDecision =
  | { readonly status: 'allowed'; readonly url: URL }
  | { readonly status: 'blocked'; readonly reason: string }
  | { readonly status: 'unresolved'; readonly reason: string };

/** An egress policy: check a URL before contacting it. */
export type EgressPolicy = {
  check(url: string | URL): Promise<EgressDecision>;
};

type AddressRange = {
  readonly bytes: Uint8Array;
  readonly prefixLength: number;
  readonly name: string;
};

const IPV4_PATTERN = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const HEX_GROUP_PATTERN = /^[0-9a-f]{1,4}$/i;

/** Four bytes for dotted-quad IPv4 text, or `null`. */
function parseIPv4(text: string): Uint8Array | null {
  const match = IPV4_PATTERN.exec(text);
  if (match === null) return null;
  const octets = match.slice(1).map(Number);
  if (octets.some((octet) => octet > 255)) return null;
  return Uint8Array.from(octets);
}

/** The 16-bit groups of one side of `::`; only the final side may end in IPv4. */
function parseGroups(text: string, final: boolean): number[] | null {
  if (text === '') return [];
  const parts = text.split(':');
  const groups: number[] = [];
  for (const [index, part] of parts.entries()) {
    const embedded = final && index === parts.length - 1 ? parseIPv4(part) : null;
    if (embedded !== null) {
      groups.push((embedded[0]! << 8) | embedded[1]!, (embedded[2]! << 8) | embedded[3]!);
      continue;
    }
    if (!HEX_GROUP_PATTERN.test(part)) return null;
    groups.push(Number.parseInt(part, 16));
  }
  return groups;
}

function ipv6Groups(address: string): number[] | null {
  const halves = address.split('::');
  if (halves.length === 1) {
    const groups = parseGroups(address, true);
    return groups?.length === 8 ? groups : null;
  }
  if (halves.length !== 2) return null;
  const head = parseGroups(halves[0]!, false);
  const tail = parseGroups(halves[1]!, true);
  if (head === null || tail === null) return null;
  const missing = 8 - head.length - tail.length;
  return missing < 1 ? null : [...head, ...Array.from({ length: missing }, () => 0), ...tail];
}

/** Sixteen bytes for IPv6 text (brackets and a zone index are ignored), or `null`. */
function parseIPv6(text: string): Uint8Array | null {
  const unbracketed = text.startsWith('[') && text.endsWith(']') ? text.slice(1, -1) : text;
  const groups = ipv6Groups(unbracketed.split('%')[0]!);
  if (groups === null) return null;
  const bytes = new Uint8Array(16);
  for (const [index, group] of groups.entries()) {
    bytes[index * 2] = group >> 8;
    bytes[index * 2 + 1] = group & 0xff;
  }
  return bytes;
}

function range(cidr: string, name: string): AddressRange {
  const [address, prefix] = cidr.split('/') as [string, string];
  const bytes = parseIPv4(address) ?? parseIPv6(address);
  if (bytes === null) throw new Error(`Invalid built-in range ${cidr}.`);
  return { bytes, prefixLength: Number(prefix), name: `${name} (${cidr})` };
}

/**
 * Every IPv4 range the IANA IPv4 Special-Purpose Address Registry marks as not
 * globally reachable, plus multicast. A block is listed whole even where the registry
 * carves out a few globally reachable addresses (in `192.0.0.0/24`), because none of
 * them is a webhook receiver.
 */
const BLOCKED_IPV4_RANGES: readonly AddressRange[] = [
  range('0.0.0.0/8', 'this network'),
  range('10.0.0.0/8', 'private'),
  range('100.64.0.0/10', 'carrier-grade NAT'),
  range('127.0.0.0/8', 'loopback'),
  range('169.254.0.0/16', 'link-local'),
  range('172.16.0.0/12', 'private'),
  range('192.0.0.0/24', 'IETF protocol assignments'),
  range('192.0.2.0/24', 'documentation'),
  range('192.168.0.0/16', 'private'),
  range('198.18.0.0/15', 'benchmarking'),
  range('198.51.100.0/24', 'documentation'),
  range('203.0.113.0/24', 'documentation'),
  range('224.0.0.0/4', 'multicast'),
  range('240.0.0.0/4', 'reserved'),
];

/**
 * Every IPv6 range the IANA IPv6 Special-Purpose Address Registry marks as not
 * globally reachable, plus multicast, listed whole as for IPv4. `2002::/16` (6to4,
 * deprecated by RFC 7526) carries an IPv4 address in its second and third groups
 * rather than its last 32 bits, so it is blocked outright.
 */
const BLOCKED_IPV6_RANGES: readonly AddressRange[] = [
  range('::/128', 'unspecified'),
  range('::1/128', 'loopback'),
  range('64:ff9b:1::/48', 'local-use NAT64'),
  range('100::/64', 'discard-only'),
  range('2001::/23', 'IETF protocol assignments'),
  range('2001:db8::/32', 'documentation'),
  range('2002::/16', '6to4'),
  range('3fff::/20', 'documentation'),
  range('5f00::/16', 'SRv6 SIDs'),
  range('fe80::/10', 'link-local'),
  range('fc00::/7', 'unique-local'),
  range('ff00::/8', 'multicast'),
];

/** IPv6 prefixes whose last 32 bits carry an IPv4 address, checked as that address. */
const IPV4_EMBEDDING_RANGES: readonly AddressRange[] = [
  range('::ffff:0:0/96', 'IPv4-mapped'),
  range('::ffff:0:0:0/96', 'IPv4-translated'),
  range('64:ff9b::/96', 'NAT64'),
  range('::/96', 'IPv4-compatible'),
];

function inRange(bytes: Uint8Array, candidate: AddressRange): boolean {
  if (bytes.length !== candidate.bytes.length) return false;
  const fullBytes = Math.floor(candidate.prefixLength / 8);
  for (let index = 0; index < fullBytes; index += 1) {
    if (bytes[index] !== candidate.bytes[index]) return false;
  }
  const remainder = candidate.prefixLength % 8;
  if (remainder === 0) return true;
  const mask = (0xff << (8 - remainder)) & 0xff;
  return (bytes[fullBytes]! & mask) === (candidate.bytes[fullBytes]! & mask);
}

function blockedIPv4Range(bytes: Uint8Array): string | null {
  return BLOCKED_IPV4_RANGES.find((candidate) => inRange(bytes, candidate))?.name ?? null;
}

/**
 * Why an address must not be contacted, or `null` when it may be. Text that is not
 * an IP address is blocked: a resolver that answers with something unparseable is
 * not evidence the destination is public.
 */
function blockedAddressReason(address: string): string | null {
  const ipv4 = parseIPv4(address);
  if (ipv4 !== null) return blockedIPv4Range(ipv4);
  const ipv6 = parseIPv6(address);
  if (ipv6 === null) return `not an IP address: ${address}`;
  const direct = BLOCKED_IPV6_RANGES.find((candidate) => inRange(ipv6, candidate));
  if (direct !== undefined) return direct.name;
  const embedding = IPV4_EMBEDDING_RANGES.find((candidate) => inRange(ipv6, candidate));
  if (embedding === undefined) return null;
  const embedded = blockedIPv4Range(ipv6.subarray(12));
  return embedded === null ? null : `${embedded} in ${embedding.name} form`;
}

function effectivePort(url: URL): string {
  if (url.port !== '') return url.port;
  return url.protocol === 'https:' ? '443' : '80';
}

/** Normalize one allowlist entry to `hostname:port`, as a URL would parse it. */
function normalizeAllowlistEntry(entry: string): string {
  if (!/:\d+$/.test(entry)) {
    throw new TypeError(`Egress allowlist entry "${entry}" must be an exact host:port pair.`);
  }
  let parsed: URL;
  try {
    parsed = new URL(`https://${entry}`);
  } catch {
    throw new TypeError(`Egress allowlist entry "${entry}" is not a valid host:port pair.`);
  }
  if (parsed.pathname !== '/' || parsed.username !== '' || parsed.search !== '') {
    throw new TypeError(`Egress allowlist entry "${entry}" must be an exact host:port pair.`);
  }
  return `${parsed.hostname}:${effectivePort(parsed)}`;
}

/** The default resolver, `node:dns` `lookup`, or `null` where the runtime has none. */
function defaultResolver(): EgressHostResolver | null {
  const dns = tryLoadNodeBuiltin('node:dns');
  if (dns === undefined) return null;
  return async (hostname) => {
    const results = await dns.promises.lookup(hostname, { all: true });
    return results.map((result) => result.address);
  };
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function checkResolvedHost(
  hostname: string,
  resolver: EgressHostResolver | null,
): Promise<{ readonly status: 'blocked' | 'unresolved'; readonly reason: string } | null> {
  if (resolver === null) {
    return {
      status: 'blocked',
      reason: `No resolver is available to check ${hostname}, and it is not on the allowlist.`,
    };
  }
  let addresses: readonly string[];
  try {
    addresses = await resolver(hostname);
  } catch (error) {
    return { status: 'unresolved', reason: `${hostname} did not resolve: ${describeError(error)}` };
  }
  if (addresses.length === 0) {
    return { status: 'unresolved', reason: `${hostname} resolved to no addresses.` };
  }
  for (const address of addresses) {
    const reason = blockedAddressReason(address);
    if (reason !== null) {
      return { status: 'blocked', reason: `${hostname} resolves to ${address}, ${reason}.` };
    }
  }
  return null;
}

/** The URL to check, or why it is refused before any address is looked at. */
function parseTarget(
  target: string | URL,
  allowInsecureHttp: boolean,
): URL | { readonly status: 'blocked'; readonly reason: string } {
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    return { status: 'blocked', reason: 'The destination is not a valid URL.' };
  }
  if (url.protocol === 'https:' || (url.protocol === 'http:' && allowInsecureHttp)) return url;
  return {
    status: 'blocked',
    reason: `The ${url.protocol} scheme is not permitted; destinations must use https.`,
  };
}

/**
 * Create an egress policy. See the module documentation for what it rejects and the
 * residual DNS-rebinding risk.
 *
 * @throws {TypeError} When an allowlist entry is not an exact `host:port` pair.
 */
export function createEgressPolicy(options: EgressPolicyOptions = {}): EgressPolicy {
  const allowInsecureHttp = options.allowInsecureHttp === true;
  const allowlist = new Set((options.allowlist ?? []).map(normalizeAllowlistEntry));
  const configuredResolver = options.resolveHost;

  return {
    async check(target) {
      const parsed = parseTarget(target, allowInsecureHttp);
      if (!(parsed instanceof URL)) return parsed;
      const url = parsed;
      if (allowlist.has(`${url.hostname}:${effectivePort(url)}`)) return { status: 'allowed', url };
      if (parseIPv4(url.hostname) !== null || url.hostname.startsWith('[')) {
        const reason = blockedAddressReason(url.hostname);
        return reason === null
          ? { status: 'allowed', url }
          : { status: 'blocked', reason: `${url.hostname} is ${reason}.` };
      }
      const resolver = configuredResolver === undefined ? defaultResolver() : configuredResolver;
      const refused = await checkResolvedHost(url.hostname, resolver);
      return refused ?? { status: 'allowed', url };
    },
  };
}
