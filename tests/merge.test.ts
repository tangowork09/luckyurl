import { describe, expect, it } from 'vitest';
import { distanceMeters, mergeBusinesses, nameSimilarity } from '../src/merge';
import type { Business } from '../src/types';

function biz(over: Partial<Business> = {}): Business {
  return {
    id: 'x',
    name: 'Blue Tokai Coffee',
    address: 'MG Road',
    googleMapsUri: '',
    types: ['cafe'],
    primaryType: 'cafe',
    location: { lat: 12.9758, lng: 77.6045 },
    ...over,
  };
}

describe('distanceMeters', () => {
  it('is ~0 for identical points', () => {
    expect(distanceMeters({ lat: 12.9, lng: 77.6 }, { lat: 12.9, lng: 77.6 })).toBeLessThan(1);
  });
  it('measures a real gap', () => {
    const d = distanceMeters({ lat: 12.9758, lng: 77.6045 }, { lat: 12.9768, lng: 77.6045 });
    expect(d).toBeGreaterThan(100);
    expect(d).toBeLessThan(130);
  });
});

describe('nameSimilarity', () => {
  it('scores near-identical names high', () => {
    expect(nameSimilarity('Blue Tokai Coffee', 'Blue Tokai Coffee Roasters')).toBeGreaterThan(0.6);
  });
  it('scores unrelated names low', () => {
    expect(nameSimilarity('Blue Tokai Coffee', 'Sharma Dental Clinic')).toBeLessThan(0.2);
  });
});

describe('mergeBusinesses', () => {
  it('overlays paid ratings onto a matched OSM record', () => {
    const osm = [biz({ id: 'osm-1', rating: undefined, ratingCount: undefined })];
    const paid = [biz({ id: 'g-1', rating: 4.6, ratingCount: 320, location: { lat: 12.97581, lng: 77.60451 } })];
    const merged = mergeBusinesses(osm, paid);
    expect(merged).toHaveLength(1);
    expect(merged[0].id).toBe('osm-1'); // OSM record kept as the base
    expect(merged[0].rating).toBe(4.6); // rating overlaid from paid source
    expect(merged[0].ratingCount).toBe(320);
  });

  it('keeps unmatched records from both sources', () => {
    const osm = [biz({ id: 'osm-1', name: 'Local Kirana', location: { lat: 12.90, lng: 77.60 } })];
    const paid = [biz({ id: 'g-1', name: 'Far Away Cafe', location: { lat: 13.10, lng: 77.90 } })];
    const merged = mergeBusinesses(osm, paid);
    expect(merged).toHaveLength(2);
  });

  it('does not merge same-name shops that are far apart', () => {
    const osm = [biz({ id: 'osm-1', location: { lat: 12.9758, lng: 77.6045 } })];
    const paid = [biz({ id: 'g-1', rating: 4.0, location: { lat: 12.99, lng: 77.62 } })];
    const merged = mergeBusinesses(osm, paid);
    expect(merged).toHaveLength(2);
  });
});
