import { describe, expect, it } from 'vitest';
import { buildOverpassQuery, osmToBusiness, type OsmElement } from '../src/overpass';
import type { ScanRequest } from '../src/types';

const req = (categories: string[] = []): ScanRequest => ({
  area: { center: { lat: 12.9758, lng: 77.6045 }, radiusMeters: 2000 },
  categories,
});

describe('buildOverpassQuery', () => {
  it('includes around filter with radius and center', () => {
    const q = buildOverpassQuery(req());
    expect(q).toContain('around:2000,12.9758,77.6045');
    expect(q).toContain('out center tags;');
  });

  it('limits selectors to the chosen groups', () => {
    const q = buildOverpassQuery(req(['food']));
    expect(q).toContain('restaurant');
    expect(q).not.toContain('car_repair');
  });

  it('unknown group keys fall back to all groups', () => {
    const q = buildOverpassQuery(req(['not-a-group']));
    expect(q).toContain('restaurant');
    expect(q).toContain('car_repair');
  });
});

describe('osmToBusiness', () => {
  const node = (tags: Record<string, string>, extra: Partial<OsmElement> = {}): OsmElement => ({
    type: 'node',
    id: 42,
    lat: 12.98,
    lon: 77.6,
    tags,
    ...extra,
  });

  it('maps a named node with OSM tags to a Business', () => {
    const b = osmToBusiness(
      node({
        name: 'Amma Bakery',
        shop: 'bakery',
        phone: '+91 90000 00000',
        website: 'https://ammabakery.in',
        'addr:housenumber': '12',
        'addr:street': 'MG Road',
        'addr:city': 'Bengaluru',
      }),
    );
    expect(b).not.toBeNull();
    expect(b!.id).toBe('osm-node-42');
    expect(b!.primaryType).toBe('bakery');
    expect(b!.websiteUri).toBe('https://ammabakery.in');
    expect(b!.address).toBe('12 MG Road, Bengaluru');
    expect(b!.googleMapsUri).toBe('https://www.openstreetmap.org/node/42');
    expect(b!.businessStatus).toBe('OPERATIONAL');
  });

  it('rejects unnamed elements', () => {
    expect(osmToBusiness(node({ shop: 'bakery' }))).toBeNull();
  });

  it('uses way center coordinates', () => {
    const b = osmToBusiness({
      type: 'way',
      id: 7,
      center: { lat: 1.5, lon: 2.5 },
      tags: { name: 'Big Shop', shop: 'clothes' },
    });
    expect(b!.location).toEqual({ lat: 1.5, lng: 2.5 });
    expect(b!.primaryType).toBe('clothing_store');
  });

  it('facebook-only contact becomes websiteUri (social-only lead signal)', () => {
    const b = osmToBusiness(
      node({ name: 'Insta Cafe', amenity: 'cafe', 'contact:facebook': 'https://facebook.com/instacafe' }),
    );
    expect(b!.websiteUri).toBe('https://facebook.com/instacafe');
  });

  it('flags disused shops as closed', () => {
    const b = osmToBusiness(node({ name: 'Old Store', 'disused:shop': 'clothes' }));
    expect(b!.businessStatus).toBe('CLOSED_PERMANENTLY');
  });
});
