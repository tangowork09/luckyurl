import { afterEach, describe, expect, it, vi } from 'vitest';
import { searchBusinesses } from '../src/places';
import type { AppConfig, ScanRequest } from '../src/types';

// searchBusinesses only reads dataSource + googleApiKey off the config on the
// google path, so a minimal cast keeps the test focused on search behaviour.
const cfg = { dataSource: 'google', googleApiKey: 'test-key' } as AppConfig;

const req = (categories: string[] = []): ScanRequest => ({
  area: { center: { lat: 12.9758, lng: 77.6045 }, radiusMeters: 2000 },
  categories,
  maxBusinesses: 10,
});

const place = (id: string) => ({
  id,
  displayName: { text: `Biz ${id}` },
  location: { latitude: 12.98, longitude: 77.6 },
});

function mockFetch(handler: () => { places: unknown[] }) {
  return vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => handler(),
    text: async () => '',
  })) as unknown as typeof fetch;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('searchBusinesses (google, concurrent pool)', () => {
  it('dedups identical places across all cells/batches', async () => {
    global.fetch = mockFetch(() => ({
      places: [place('a'), place('b'), place('c')],
    }));

    const businesses = await searchBusinesses(cfg, req(['food']));
    expect(businesses.map((b) => b.id).sort()).toEqual(['a', 'b', 'c']);
  });

  it('respects maxBusinesses even with many unique results in flight', async () => {
    let n = 0;
    global.fetch = mockFetch(() => ({
      // Every request yields fresh unique ids so only `max` can cap the total.
      places: Array.from({ length: 20 }, () => place(`u${n++}`)),
    }));

    const businesses = await searchBusinesses(cfg, req());
    expect(businesses).toHaveLength(10);
    // All ids are distinct (dedup Map preserved under concurrency).
    expect(new Set(businesses.map((b) => b.id)).size).toBe(10);
  });

  it('throws the all-failed error when every request fails', async () => {
    global.fetch = vi.fn(async () => ({
      ok: false,
      status: 403,
      json: async () => ({}),
      text: async () => 'forbidden',
    })) as unknown as typeof fetch;

    await expect(searchBusinesses(cfg, req(['food']))).rejects.toThrow(
      /all \d+ requests failed/,
    );
  });
});
