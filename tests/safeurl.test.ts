import { afterEach, describe, expect, it, vi } from 'vitest';
import { assertPublicUrl, isBlockedIp, safeFetch, SsrfError, type LookupAllFn } from '../src/safeurl';

/** Mock resolver that always returns one public address. */
const publicLookup: LookupAllFn = async () => [{ address: '93.184.216.34', family: 4 }];
/** Mock resolver that returns a private address (DNS-rebinding style). */
const privateLookup: LookupAllFn = async () => [{ address: '10.1.2.3', family: 4 }];

describe('isBlockedIp — range classification', () => {
  it('blocks loopback / private / link-local / metadata / unspecified / multicast', () => {
    for (const ip of [
      '127.0.0.1', '127.5.5.5', // loopback
      '10.0.0.1', '172.16.0.1', '172.31.255.255', '192.168.1.1', // private
      '169.254.0.1', '169.254.169.254', // link-local incl. cloud metadata
      '100.64.0.1', // carrier-grade NAT
      '0.0.0.0', // unspecified
      '224.0.0.1', '239.255.255.255', // multicast
      '255.255.255.255', // broadcast
      '::1', '::', // v6 loopback + unspecified
      'fe80::1', // v6 link-local
      'fc00::1', 'fd12:3456::1', // v6 unique-local
      'ff02::1', // v6 multicast
      '::ffff:169.254.169.254', // v4-mapped metadata
      '::ffff:10.0.0.1', // v4-mapped private
    ]) {
      expect(isBlockedIp(ip), ip).toBe(true);
    }
  });

  it('allows ordinary public addresses', () => {
    for (const ip of ['93.184.216.34', '8.8.8.8', '1.1.1.1', '172.15.0.1', '172.32.0.1', '2606:4700:4700::1111']) {
      expect(isBlockedIp(ip), ip).toBe(false);
    }
  });

  it('treats unparseable input as blocked (fail closed)', () => {
    expect(isBlockedIp('not-an-ip')).toBe(true);
  });
});

describe('assertPublicUrl', () => {
  it('rejects non-http(s) schemes', async () => {
    await expect(assertPublicUrl('ftp://example.com/', publicLookup)).rejects.toThrow(SsrfError);
    await expect(assertPublicUrl('file:///etc/passwd', publicLookup)).rejects.toThrow(SsrfError);
  });

  it('rejects localhost and raw private/loopback/link-local/metadata IP hosts', async () => {
    for (const url of [
      'http://localhost/',
      'http://sub.localhost/',
      'http://127.0.0.1/',
      'http://10.0.0.5/admin',
      'http://192.168.1.1/',
      'http://169.254.169.254/latest/meta-data/', // AWS/GCP metadata endpoint
      'http://[::1]/',
      'http://[fe80::1]/',
    ]) {
      await expect(assertPublicUrl(url, publicLookup), url).rejects.toThrow(SsrfError);
    }
  });

  it('rejects a public hostname that RESOLVES to a private IP (rebinding)', async () => {
    await expect(assertPublicUrl('https://rebind.evil.example/', privateLookup)).rejects.toThrow(SsrfError);
  });

  it('accepts a normal public URL', async () => {
    const url = await assertPublicUrl('https://example.com/path', publicLookup);
    expect(url.hostname).toBe('example.com');
  });

  it('rejects a raw public-IP host? no — allows it when public', async () => {
    const url = await assertPublicUrl('http://93.184.216.34/', publicLookup);
    expect(url.hostname).toBe('93.184.216.34');
  });
});

describe('safeFetch — redirect re-validation', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  it('blocks a redirect from a public URL to the metadata IP', async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const u = String(input);
      if (u.startsWith('https://public.example')) {
        return new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data/' } });
      }
      return new Response('should never be reached', { status: 200 });
    }) as typeof fetch;

    await expect(safeFetch('https://public.example/', { lookupFn: publicLookup })).rejects.toThrow(SsrfError);
  });

  it('follows a redirect between two public URLs and returns the final response', async () => {
    const seen: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const u = String(input);
      seen.push(u);
      if (u === 'https://public.example/') {
        return new Response(null, { status: 301, headers: { location: 'https://public.example/final' } });
      }
      return new Response('ok', { status: 200 });
    }) as typeof fetch;

    const res = await safeFetch('https://public.example/', { lookupFn: publicLookup });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok');
    expect(seen).toEqual(['https://public.example/', 'https://public.example/final']);
  });

  it('gives up after too many redirects', async () => {
    globalThis.fetch = (async () =>
      new Response(null, { status: 302, headers: { location: 'https://public.example/loop' } })) as typeof fetch;
    await expect(safeFetch('https://public.example/', { lookupFn: publicLookup, maxRedirects: 3 })).rejects.toThrow(
      /Too many redirects/,
    );
  });
});
