/**
 * SSRF protection for outbound fetches to attacker-controllable URLs.
 *
 * Business `websiteUri` values come from world-editable sources (OSM `website`
 * tag, self-declared Google Business Profile URL), so before we fetch one we
 * must prove the target is a *public* internet host — never loopback, private,
 * link-local (incl. the 169.254.169.254 cloud-metadata endpoint), unspecified,
 * or multicast. We also follow redirects MANUALLY and re-validate every hop's
 * resolved IP, which defeats DNS-rebinding and redirect-to-internal attacks.
 *
 * `assertPublicUrl(url)` throws SsrfError on a blocked target (dependency-
 * injectable DNS lookup so it's unit-testable). `safeFetch(url, opts)` is a
 * drop-in fetch that validates the URL and each redirect hop.
 */
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export class SsrfError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SsrfError';
  }
}

/** DNS resolver shape we depend on (node's dns.promises.lookup with all:true). */
export type LookupAllFn = (
  hostname: string,
  options: { all: true },
) => Promise<Array<{ address: string; family: number }>>;

const defaultLookup: LookupAllFn = (hostname, options) => lookup(hostname, options);

const MAX_REDIRECTS = 5;

/* --------------------------- IP range checks --------------------------- */

function ipv4ToBytes(ip: string): number[] | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  const bytes = parts.map((p) => Number(p));
  if (bytes.some((b) => !Number.isInteger(b) || b < 0 || b > 255)) return null;
  return bytes;
}

/** Expand any valid IPv6 (incl. `::` compression + embedded IPv4) to 16 bytes. */
function ipv6ToBytes(input: string): number[] | null {
  let ip = input.split('%')[0]; // strip zone id (fe80::1%eth0)
  // Embedded IPv4 tail (::ffff:1.2.3.4) → rewrite as two hextets.
  if (ip.includes('.')) {
    const idx = ip.lastIndexOf(':');
    const v4 = ipv4ToBytes(ip.slice(idx + 1));
    if (!v4) return null;
    const hi = ((v4[0] << 8) | v4[1]).toString(16);
    const lo = ((v4[2] << 8) | v4[3]).toString(16);
    ip = `${ip.slice(0, idx + 1)}${hi}:${lo}`;
  }
  const halves = ip.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  let groups: string[];
  if (halves.length === 2) {
    const tail = halves[1] ? halves[1].split(':') : [];
    const missing = 8 - head.length - tail.length;
    if (missing < 0) return null;
    groups = [...head, ...Array<string>(missing).fill('0'), ...tail];
  } else {
    groups = head;
  }
  if (groups.length !== 8) return null;
  const bytes: number[] = [];
  for (const g of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
    const n = parseInt(g, 16);
    bytes.push((n >> 8) & 0xff, n & 0xff);
  }
  return bytes;
}

function isBlockedIpv4(b: number[]): boolean {
  const [a, c] = b;
  if (a === 0) return true; // 0.0.0.0/8 "this network" (incl. 0.0.0.0 unspecified)
  if (a === 10) return true; // 10/8 private
  if (a === 127) return true; // 127/8 loopback
  if (a === 100 && c >= 64 && c <= 127) return true; // 100.64/10 carrier-grade NAT
  if (a === 169 && c === 254) return true; // 169.254/16 link-local (incl. 169.254.169.254 metadata)
  if (a === 172 && c >= 16 && c <= 31) return true; // 172.16/12 private
  if (a === 192 && c === 168) return true; // 192.168/16 private
  if (a >= 224) return true; // 224/4 multicast + 240/4 reserved + 255.255.255.255 broadcast
  return false;
}

function isBlockedIpv6(b: number[]): boolean {
  if (b.every((x) => x === 0)) return true; // :: unspecified
  if (b.slice(0, 15).every((x) => x === 0) && b[15] === 1) return true; // ::1 loopback
  if (b[0] === 0xff) return true; // ff00::/8 multicast
  if (b[0] === 0xfe && (b[1] & 0xc0) === 0x80) return true; // fe80::/10 link-local
  if ((b[0] & 0xfe) === 0xfc) return true; // fc00::/7 unique-local (private)
  return false;
}

/**
 * True when `ip` (a literal, IPv4 or IPv6) is NOT a routable public address and
 * must be refused. Unparseable input is treated as blocked (fail closed).
 */
export function isBlockedIp(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 4) return isBlockedIpv4(ipv4ToBytes(ip)!);
  if (kind === 6) {
    const bytes = ipv6ToBytes(ip);
    if (!bytes) return true;
    // IPv4-mapped ::ffff:a.b.c.d — judge by the embedded IPv4.
    if (bytes.slice(0, 10).every((x) => x === 0) && bytes[10] === 0xff && bytes[11] === 0xff) {
      return isBlockedIpv4(bytes.slice(12));
    }
    return isBlockedIpv6(bytes);
  }
  return true;
}

/* ---------------------------- URL validation --------------------------- */

/**
 * Resolve `rawUrl` and throw SsrfError unless it targets a public host over
 * http/https. Every resolved address (A + AAAA) must be public — a single
 * private/link-local answer rejects the whole host (blocks split-horizon /
 * rebinding tricks). Raw-IP hosts are checked directly (no DNS).
 */
export async function assertPublicUrl(rawUrl: string, lookupFn: LookupAllFn = defaultLookup): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new SsrfError(`Invalid URL: ${rawUrl}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new SsrfError(`Blocked non-http(s) URL scheme: ${url.protocol}`);
  }
  const host = url.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost')) {
    throw new SsrfError('Blocked localhost.');
  }
  // IPv6 literals arrive bracketed from URL.hostname (e.g. "[::1]").
  const literal = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  if (isIP(literal)) {
    if (isBlockedIp(literal)) throw new SsrfError(`Blocked non-public IP host: ${literal}`);
    return url;
  }

  let results: Array<{ address: string; family: number }>;
  try {
    results = await lookupFn(host, { all: true });
  } catch {
    throw new SsrfError(`DNS resolution failed for host: ${host}`);
  }
  if (!results || results.length === 0) {
    throw new SsrfError(`No DNS records for host: ${host}`);
  }
  for (const r of results) {
    if (isBlockedIp(r.address)) {
      throw new SsrfError(`Host ${host} resolves to a non-public IP: ${r.address}`);
    }
  }
  return url;
}

export interface SafeFetchOptions extends RequestInit {
  /** Injectable DNS resolver (tests). */
  lookupFn?: LookupAllFn;
  /** Redirect hop cap (default 5). */
  maxRedirects?: number;
}

/**
 * fetch() that validates the target — and every redirect Location — as a public
 * URL before each network call. Redirects are followed MANUALLY (redirect:
 * 'manual') so we re-resolve and re-check each hop, defeating a public→internal
 * redirect and DNS-rebinding between the check and the connect.
 */
export async function safeFetch(rawUrl: string, opts: SafeFetchOptions = {}): Promise<Response> {
  const { lookupFn = defaultLookup, maxRedirects = MAX_REDIRECTS, ...init } = opts;
  let currentUrl = rawUrl;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    await assertPublicUrl(currentUrl, lookupFn);
    const res = await fetch(currentUrl, { ...init, redirect: 'manual' });
    const location = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
    if (!location) return res;
    // Drain the redirect body before chasing the next hop.
    res.body?.cancel().catch(() => {});
    currentUrl = new URL(location, currentUrl).href;
  }
  throw new SsrfError(`Too many redirects (>${maxRedirects}).`);
}
