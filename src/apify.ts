/**
 * Apify data source — the paid, no-Google-billing-card path.
 *
 * Runs a Google-Maps scraper actor (default compass/crawler-google-places) via
 * Apify's run-sync-get-dataset-items REST endpoint using the user's own
 * APIFY_TOKEN. The ToS/liability for scraping sits with the user and their
 * Apify account; LeadScout just consumes the resulting dataset. Costs the
 * user's Apify credits per run (~$1.50 / 1000 places at the time of writing).
 */
import { CATEGORY_GROUPS } from './categories';
import { normalizeIndianPhone } from './phone';
import type { AppConfig, Business, ProgressFn, ScanRequest } from './types';

const RUN_TIMEOUT_MS = 280_000; // Apify sync runs can take minutes; cap generously.

interface ApifyPlace {
  placeId?: string;
  title?: string;
  address?: string;
  street?: string;
  city?: string;
  phone?: string;
  phoneUnformatted?: string;
  website?: string;
  url?: string;
  totalScore?: number;
  reviewsCount?: number;
  categoryName?: string;
  categories?: string[];
  emails?: string[];
  permanentlyClosed?: boolean;
  temporarilyClosed?: boolean;
  location?: { lat?: number; lng?: number };
}

/** Human category labels for the actor's text search (it takes strings, not types). */
function searchStrings(categories: string[]): string[] {
  const keys = categories.length > 0 ? categories : CATEGORY_GROUPS.map((g) => g.key);
  const labels = keys
    .map((k) => CATEGORY_GROUPS.find((g) => g.key === k)?.label)
    .filter((l): l is string => Boolean(l));
  return labels.length > 0 ? labels : ['business'];
}

function toBusiness(p: ApifyPlace): Business | null {
  const name = p.title;
  const lat = p.location?.lat;
  const lng = p.location?.lng;
  if (!name || typeof lat !== 'number' || typeof lng !== 'number') return null;

  const phone = p.phone ?? p.phoneUnformatted;
  const norm = normalizeIndianPhone(phone);
  const status = p.permanentlyClosed
    ? 'CLOSED_PERMANENTLY'
    : p.temporarilyClosed
      ? 'CLOSED_TEMPORARILY'
      : 'OPERATIONAL';

  const business: Business = {
    id: `apify-${p.placeId ?? `${name}-${lat},${lng}`}`,
    name,
    address: p.address ?? [p.street, p.city].filter(Boolean).join(', '),
    phone,
    websiteUri: p.website,
    googleMapsUri: p.url ?? '',
    rating: p.totalScore,
    ratingCount: p.reviewsCount,
    primaryType: p.categoryName,
    types: p.categories ?? (p.categoryName ? [p.categoryName] : []),
    businessStatus: status,
    location: { lat, lng },
  };
  if (norm.e164) business.phoneE164 = norm.e164;
  if (norm.whatsappUri) business.whatsappUri = norm.whatsappUri;
  if (p.emails && p.emails.length > 0) business.email = p.emails[0];
  return business;
}

export async function searchApifyBusinesses(
  cfg: AppConfig,
  req: ScanRequest,
  onProgress?: ProgressFn,
): Promise<Business[]> {
  const max = req.maxBusinesses ?? 300;
  const { lat, lng } = req.area.center;
  const actor = encodeURIComponent(cfg.apifyActorId).replace(/%2F/gi, '~');
  const url =
    `https://api.apify.com/v2/acts/${actor}/run-sync-get-dataset-items` +
    `?token=${encodeURIComponent(cfg.apifyToken!)}`;

  const input = {
    searchStringsArray: searchStrings(req.categories),
    customGeolocation: {
      type: 'Point',
      coordinates: [lng, lat],
      radiusKm: Math.max(1, Math.round(req.area.radiusMeters / 1000)),
    },
    maxCrawledPlacesPerSearch: Math.min(max, 300),
    language: 'en',
    // We only need the listing fields LeadScout maps; skip expensive enrichment.
    scrapeReviews: false,
    scrapeContacts: true,
  };

  onProgress?.({ type: 'search', found: 0, cell: 1, cells: 1 });
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
    signal: AbortSignal.timeout(RUN_TIMEOUT_MS),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Apify run failed (HTTP ${res.status}): ${text.slice(0, 300)}`);
  }
  const items = (await res.json()) as ApifyPlace[];

  const unique = new Map<string, Business>();
  for (const item of Array.isArray(items) ? items : []) {
    const business = toBusiness(item);
    if (business && !unique.has(business.id)) unique.set(business.id, business);
    if (unique.size >= max) break;
  }
  onProgress?.({ type: 'search', found: unique.size, cell: 1, cells: 1 });
  return [...unique.values()];
}
