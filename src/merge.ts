/**
 * Merge two business lists from different sources (e.g. free OSM + paid
 * Google/Apify) into one deduped list: keep OSM's long-tail coverage while
 * overlaying the paid source's ratings/review counts. Pure and testable.
 *
 * Match rule is deliberately conservative — same location (<60 m) AND similar
 * name — to avoid falsely merging two different shops in the same plaza.
 */
import type { Business } from './types';

const MATCH_DISTANCE_M = 60;
const NAME_SIMILARITY = 0.6;

/** Haversine distance in metres. */
export function distanceMeters(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6_371_000;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const lat1 = (a.lat * Math.PI) / 180;
  const lat2 = (b.lat * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function normName(n: string): string {
  return n
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\b(the|a|an|pvt|ltd|llp|inc|co)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Token Jaccard similarity of two names, 0..1. */
export function nameSimilarity(a: string, b: string): number {
  const ta = new Set(normName(a).split(' ').filter(Boolean));
  const tb = new Set(normName(b).split(' ').filter(Boolean));
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return inter / (ta.size + tb.size - inter);
}

function isSameBusiness(a: Business, b: Business): boolean {
  return (
    distanceMeters(a.location, b.location) <= MATCH_DISTANCE_M &&
    nameSimilarity(a.name, b.name) >= NAME_SIMILARITY
  );
}

/** Overlay paid fields (rating/reviews/phone/website/email) onto a base record. */
function overlay(base: Business, rich: Business): Business {
  return {
    ...base,
    rating: rich.rating ?? base.rating,
    ratingCount: rich.ratingCount ?? base.ratingCount,
    phone: base.phone ?? rich.phone,
    phoneE164: base.phoneE164 ?? rich.phoneE164,
    whatsappUri: base.whatsappUri ?? rich.whatsappUri,
    email: base.email ?? rich.email,
    websiteUri: base.websiteUri ?? rich.websiteUri,
    googleMapsUri: base.googleMapsUri || rich.googleMapsUri,
    // Google/Apify status/types are usually better than OSM's.
    businessStatus: rich.businessStatus ?? base.businessStatus,
    primaryType: base.primaryType ?? rich.primaryType,
  };
}

/**
 * primary = the coverage source (usually OSM); enrich = the rating source.
 * Returns primary records enriched where matched, plus any enrich-only records
 * that had no match in primary.
 */
export function mergeBusinesses(primary: Business[], enrich: Business[]): Business[] {
  const usedEnrich = new Set<number>();
  const merged: Business[] = primary.map((p) => {
    const idx = enrich.findIndex((e, i) => !usedEnrich.has(i) && isSameBusiness(p, e));
    if (idx === -1) return p;
    usedEnrich.add(idx);
    return overlay(p, enrich[idx]);
  });
  enrich.forEach((e, i) => {
    if (!usedEnrich.has(i)) merged.push(e);
  });
  return merged;
}
