import { describe, expect, it } from 'vitest';
import { gridCells } from '../src/grid';
import type { LatLng, ScanArea } from '../src/types';

const METERS_PER_DEG_LAT = 111320;

/** Same equirectangular conversion grid.ts uses, anchored at the area center lat. */
function metersBetween(a: LatLng, b: LatLng, refLatDeg: number): number {
  const dy = (a.lat - b.lat) * METERS_PER_DEG_LAT;
  const dx =
    (a.lng - b.lng) * METERS_PER_DEG_LAT * Math.cos((refLatDeg * Math.PI) / 180);
  return Math.hypot(dx, dy);
}

describe('gridCells', () => {
  const center: LatLng = { lat: 12.97, lng: 77.59 };

  it('returns the area itself when radius fits in one cell', () => {
    const small: ScanArea = { center, radiusMeters: 500 };
    expect(gridCells(small)).toEqual([small]);

    const exact: ScanArea = { center, radiusMeters: 800 };
    expect(gridCells(exact)).toHaveLength(1);
  });

  it('fully covers a 3km circle: every sampled point is within 800m of a cell center', () => {
    const radius = 3000;
    const maxCellRadius = 800;
    const area: ScanArea = { center, radiusMeters: radius };
    const cells = gridCells(area, maxCellRadius);

    for (const cell of cells) expect(cell.radiusMeters).toBe(maxCellRadius);

    // Deterministic grid-spaced sample of >= 500 points inside the big circle.
    const metersPerDegLng =
      METERS_PER_DEG_LAT * Math.cos((center.lat * Math.PI) / 180);
    const steps = 30; // 31x31 candidates, ~754 land inside the circle
    const points: LatLng[] = [];
    for (let i = 0; i <= steps; i++) {
      for (let j = 0; j <= steps; j++) {
        const x = -radius + (2 * radius * i) / steps;
        const y = -radius + (2 * radius * j) / steps;
        if (Math.hypot(x, y) > radius) continue;
        points.push({
          lat: center.lat + y / METERS_PER_DEG_LAT,
          lng: center.lng + x / metersPerDegLng,
        });
      }
    }
    expect(points.length).toBeGreaterThanOrEqual(500);
    const sample = points.slice(0, 500);

    for (const point of sample) {
      const nearest = Math.min(
        ...cells.map((cell) => metersBetween(point, cell.center, center.lat)),
      );
      expect(nearest).toBeLessThanOrEqual(maxCellRadius);
    }
  });

  it('produces a sane cell count for 3km / 800m', () => {
    const cells = gridCells({ center, radiusMeters: 3000 }, 800);
    expect(cells.length).toBeLessThan(80);
    expect(cells.length).toBeGreaterThan(5);
  });
});
