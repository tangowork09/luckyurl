import type { ScanArea } from './types';

const METERS_PER_DEG_LAT = 111320;

/**
 * Covers the requested circle with overlapping cells of radius
 * `maxCellRadius` arranged on a hexagonal (triangular) lattice.
 *
 * Coverage guarantee: with nearest-neighbor spacing s, a triangular lattice
 * covers the plane with discs of radius s/sqrt(3) (the deepest hole is a
 * triangle circumcenter). We use s = maxCellRadius * sqrt(3) * 0.95, so the
 * covering radius is 0.95 * maxCellRadius — strictly inside each cell. Any
 * point p in the big circle has its nearest lattice center within that
 * covering radius, and that center lies within radiusMeters + coveringRadius
 * of the area center, so keeping all centers inside that expanded radius
 * retains a covering cell for every point of the big circle.
 */
export function gridCells(area: ScanArea, maxCellRadius = 800): ScanArea[] {
  if (area.radiusMeters <= maxCellRadius) return [area];

  const s = maxCellRadius * Math.sqrt(3) * 0.95;
  const rowHeight = (s * Math.sqrt(3)) / 2;
  const coveringRadius = s / Math.sqrt(3);
  const keepRadius = area.radiusMeters + coveringRadius;

  const metersPerDegLng =
    METERS_PER_DEG_LAT * Math.cos((area.center.lat * Math.PI) / 180);

  const cells: ScanArea[] = [];
  const maxRow = Math.ceil(keepRadius / rowHeight);
  const maxCol = Math.ceil(keepRadius / s) + 1;

  for (let row = -maxRow; row <= maxRow; row++) {
    const y = row * rowHeight;
    const xOffset = row % 2 === 0 ? 0 : s / 2; // alternate-row hex offset
    for (let col = -maxCol; col <= maxCol; col++) {
      const x = col * s + xOffset;
      if (Math.hypot(x, y) > keepRadius) continue;
      cells.push({
        center: {
          lat: area.center.lat + y / METERS_PER_DEG_LAT,
          lng: area.center.lng + x / metersPerDegLng,
        },
        radiusMeters: maxCellRadius,
      });
    }
  }
  return cells;
}
