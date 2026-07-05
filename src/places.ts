import { CATEGORY_GROUPS } from './categories';
import { gridCells } from './grid';
import { mockBusinesses } from './mock';
import { searchOsmBusinesses } from './overpass';
import { searchApifyBusinesses } from './apify';
import { normalizeIndianPhone } from './phone';
import type {
  AppConfig,
  Business,
  ProgressFn,
  ScanArea,
  ScanRequest,
} from './types';

const PLACES_URL = 'https://places.googleapis.com/v1/places:searchNearby';
const FIELD_MASK = [
  'places.id',
  'places.displayName',
  'places.formattedAddress',
  'places.location',
  'places.rating',
  'places.userRatingCount',
  'places.websiteUri',
  'places.nationalPhoneNumber',
  'places.googleMapsUri',
  'places.types',
  'places.primaryType',
  'places.businessStatus',
].join(',');

const DEFAULT_MAX_BUSINESSES = 300;
const MAX_RETRIES = 3;
const RETRY_BASE_MS = 500;
const POLITENESS_DELAY_MS = 100;
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_TYPES_PER_BATCH = 8;

interface RawPlace {
  id?: string;
  displayName?: { text?: string };
  formattedAddress?: string;
  location?: { latitude?: number; longitude?: number };
  rating?: number;
  userRatingCount?: number;
  websiteUri?: string;
  nationalPhoneNumber?: string;
  googleMapsUri?: string;
  types?: string[];
  primaryType?: string;
  businessStatus?: string;
}

type BatchResult =
  | { ok: true; places: RawPlace[] }
  | { ok: false; error: string };

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Request categories may be group keys ("food") or raw Places type strings.
 * Group keys expand to their type list; unknown entries pass through as raw
 * types in batches of <= 8. Empty input means every category group.
 */
function resolveTypeBatches(categories: string[]): string[][] {
  if (categories.length === 0) return CATEGORY_GROUPS.map((g) => g.types);
  const batches: string[][] = [];
  const rawTypes: string[] = [];
  for (const entry of categories) {
    const group = CATEGORY_GROUPS.find((g) => g.key === entry);
    if (group) batches.push(group.types);
    else rawTypes.push(entry);
  }
  for (let i = 0; i < rawTypes.length; i += MAX_TYPES_PER_BATCH) {
    batches.push(rawTypes.slice(i, i + MAX_TYPES_PER_BATCH));
  }
  return batches;
}

function toBusiness(p: RawPlace): Business | null {
  if (!p.id || typeof p.location?.latitude !== 'number' || typeof p.location.longitude !== 'number') {
    return null;
  }
  const norm = normalizeIndianPhone(p.nationalPhoneNumber);
  const business: Business = {
    id: p.id,
    name: p.displayName?.text ?? '(unnamed)',
    address: p.formattedAddress ?? '',
    phone: p.nationalPhoneNumber,
    websiteUri: p.websiteUri,
    googleMapsUri: p.googleMapsUri ?? '',
    rating: p.rating,
    ratingCount: p.userRatingCount,
    primaryType: p.primaryType,
    types: p.types ?? [],
    businessStatus: p.businessStatus,
    location: { lat: p.location.latitude, lng: p.location.longitude },
  };
  if (norm.e164) business.phoneE164 = norm.e164;
  if (norm.whatsappUri) business.whatsappUri = norm.whatsappUri;
  return business;
}

async function searchNearbyBatch(
  apiKey: string,
  cell: ScanArea,
  types: string[],
): Promise<BatchResult> {
  const body = JSON.stringify({
    includedTypes: types,
    maxResultCount: 20,
    locationRestriction: {
      circle: {
        center: { latitude: cell.center.lat, longitude: cell.center.lng },
        radius: cell.radiusMeters,
      },
    },
  });

  let lastError = '';
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(PLACES_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': apiKey,
          'X-Goog-FieldMask': FIELD_MASK,
        },
        body,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });

      if (res.ok) {
        const data = (await res.json()) as { places?: RawPlace[] };
        return { ok: true, places: data.places ?? [] };
      }

      const text = await res.text();
      if (res.status === 400) {
        // Likely an invalid type string (or bad key) — must not kill the scan.
        console.warn(
          `Places API 400 for types [${types.join(', ')}] — skipping batch: ${text}`,
        );
        return { ok: false, error: `HTTP 400: ${text}` };
      }
      lastError = `HTTP ${res.status}: ${text}`;
      // Only 429 and 5xx are worth retrying; 401/403 etc. never recover.
      if (res.status !== 429 && res.status < 500) return { ok: false, error: lastError };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    if (attempt < MAX_RETRIES) await sleep(RETRY_BASE_MS * 2 ** attempt);
  }
  return { ok: false, error: lastError };
}

export async function searchBusinesses(
  cfg: AppConfig,
  req: ScanRequest,
  onProgress?: ProgressFn,
): Promise<Business[]> {
  const max = req.maxBusinesses ?? DEFAULT_MAX_BUSINESSES;

  if (cfg.dataSource === 'demo') {
    const businesses = mockBusinesses(req.area, req.categories).slice(0, max);
    onProgress?.({ type: 'search', found: businesses.length, cell: 1, cells: 1 });
    return businesses;
  }

  if (cfg.dataSource === 'osm') {
    return searchOsmBusinesses(req, onProgress);
  }

  if (cfg.dataSource === 'apify') {
    if (!cfg.apifyToken) {
      throw new Error('searchBusinesses: APIFY_TOKEN missing but dataSource is apify.');
    }
    return searchApifyBusinesses(cfg, req, onProgress);
  }

  if (!cfg.googleApiKey) {
    throw new Error('searchBusinesses: GOOGLE_MAPS_API_KEY missing but dataSource is google.');
  }

  const cells = gridCells(req.area);
  const batches = resolveTypeBatches(req.categories);
  const unique = new Map<string, Business>();

  let attempted = 0;
  let failed = 0;
  let lastError = '';

  for (let ci = 0; ci < cells.length && unique.size < max; ci++) {
    for (const types of batches) {
      if (unique.size >= max) break;
      attempted++;
      const result = await searchNearbyBatch(cfg.googleApiKey, cells[ci], types);
      if (result.ok) {
        for (const raw of result.places) {
          const business = toBusiness(raw);
          if (business && !unique.has(business.id)) unique.set(business.id, business);
        }
      } else {
        failed++;
        lastError = result.error;
      }
      await sleep(POLITENESS_DELAY_MS);
    }
    onProgress?.({
      type: 'search',
      found: Math.min(unique.size, max),
      cell: ci + 1,
      cells: cells.length,
    });
  }

  if (attempted > 0 && failed === attempted) {
    throw new Error(
      `Places API: all ${attempted} requests failed — check GOOGLE_MAPS_API_KEY and that ` +
        `Places API (New) is enabled with billing. Last error: ${lastError}`,
    );
  }

  return [...unique.values()].slice(0, max);
}
