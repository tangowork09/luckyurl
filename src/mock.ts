import { ALL_TYPES, CATEGORY_GROUPS } from './categories';
import type {
  Business,
  ScanArea,
  WebsiteAudit,
  WebsiteIssue,
  WebsiteIssueId,
} from './types';

/** FNV-1a 32-bit — the single source of "randomness" so runs are identical. */
function fnv1a(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

const METERS_PER_DEG_LAT = 111320;
const MOCK_COUNT = 30;

const NAME_PREFIXES = [
  'Sharma',
  'Blue Leaf',
  'Sri Ganesh',
  'Urban Fade',
  'Lakshmi',
  'Annapurna',
  'Royal Orchid',
  'Kaveri',
  'Shree Balaji',
  'Sunrise',
  'Green Park',
  'Patel',
  'Mehta & Sons',
  'Golden Lotus',
  'Silver Oak',
  'Nandini',
  'Prakash',
  'Reddy',
  'Gupta',
  'Modern',
  'Classic',
  'Peacock',
  'Tulsi',
  'Amber',
  'Coastal Spice',
  'Jasmine',
  'Vintage Charm',
  'Happy Days',
  'New Krishna',
  'Marigold',
];

const TYPE_SUFFIX: Record<string, string> = {
  restaurant: 'Restaurant',
  cafe: 'Cafe',
  bakery: 'Bakery',
  bar: 'Bar & Kitchen',
  meal_takeaway: 'Tiffin Centre',
  clothing_store: 'Fashions',
  shoe_store: 'Footwear',
  jewelry_store: 'Jewellers',
  furniture_store: 'Furniture Mart',
  electronics_store: 'Electronics',
  hardware_store: 'Hardware Stores',
  book_store: 'Book House',
  gift_shop: 'Gift Corner',
  florist: 'Flower Shop',
  convenience_store: 'Super Mart',
  pet_store: 'Pet Shop',
  dentist: 'Dental Clinic',
  doctor: 'Polyclinic',
  physiotherapist: 'Physiotherapy Centre',
  pharmacy: 'Pharmacy',
  veterinary_care: 'Pet Clinic',
  beauty_salon: 'Beauty Parlour',
  hair_salon: 'Hair Studio',
  barber_shop: 'Barbershop',
  spa: 'Spa & Wellness',
  gym: 'Fitness Studio',
  yoga_studio: 'Yoga Shala',
  lawyer: 'Law Associates',
  accounting: 'Accounting Services',
  insurance_agency: 'Insurance Services',
  real_estate_agency: 'Properties',
  travel_agency: 'Tours & Travels',
  plumber: 'Plumbing Works',
  electrician: 'Electricals',
  painter: 'Painting Services',
  locksmith: 'Key Works',
  moving_company: 'Packers & Movers',
  laundry: 'Dry Cleaners',
  car_repair: 'Auto Garage',
  car_dealer: 'Motors',
  car_wash: 'Car Spa',
};

const STREETS = [
  'MG Road',
  'Brigade Road',
  '100 Feet Road',
  'Church Street',
  'Residency Road',
  'Commercial Street',
  'Jayanagar 4th Block',
  'Koramangala 5th Block',
  'Indiranagar 12th Main',
  'HSR Layout Sector 2',
];

/**
 * Website mix applied by index so the ~40/15/10/35 split is exact and stable:
 * 8x none, 3x social, 2x broken, 7x real per 20 businesses.
 */
type SitePattern = 'none' | 'social' | 'broken' | 'site';
const SITE_PATTERN: SitePattern[] = [
  'none', 'none', 'site', 'social', 'none', 'site', 'broken', 'none', 'site', 'social',
  'none', 'site', 'none', 'none', 'broken', 'site', 'social', 'none', 'site', 'site',
];

function suffixFor(type: string): string {
  return (
    TYPE_SUFFIX[type] ??
    type
      .split('_')
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ')
  );
}

/** Category entries may be group keys or raw Places type strings. */
function resolveTypes(categories: string[]): string[] {
  if (categories.length === 0) return ALL_TYPES;
  const types: string[] = [];
  for (const entry of categories) {
    const group = CATEGORY_GROUPS.find((g) => g.key === entry);
    if (group) types.push(...group.types);
    else types.push(entry);
  }
  return [...new Set(types)];
}

function websiteFor(pattern: SitePattern, slug: string, phoneDigits: string, h: number): string | undefined {
  switch (pattern) {
    case 'none':
      return undefined;
    case 'social': {
      const kind = h % 3;
      if (kind === 0) return `https://www.facebook.com/${slug}`;
      if (kind === 1) return `https://instagram.com/${slug}`;
      return `https://wa.me/91${phoneDigits}`;
    }
    case 'broken':
      return `https://${slug}-broken.example.com`;
    case 'site':
      return `https://www.${slug}.in`;
  }
}

export function mockBusinesses(area: ScanArea, categories: string[]): Business[] {
  const types = resolveTypes(categories);
  const businesses: Business[] = [];

  for (let i = 0; i < MOCK_COUNT; i++) {
    const prefix = NAME_PREFIXES[i % NAME_PREFIXES.length];
    const seed = fnv1a(`${prefix}#${i}`);
    const type = types[(seed >>> 4) % types.length];
    const name = `${prefix} ${suffixFor(type)}`;
    const slug = slugify(name);
    const h = fnv1a(name);

    // sqrt keeps the spatial spread roughly uniform over the disc area.
    const angle = ((h % 3600) / 3600) * 2 * Math.PI;
    const dist = area.radiusMeters * 0.95 * Math.sqrt(((h >>> 8) % 1000) / 1000);
    const metersPerDegLng =
      METERS_PER_DEG_LAT * Math.cos((area.center.lat * Math.PI) / 180);

    const phoneDigits = `9${String(h % 1_000_000_000).padStart(9, '0')}`;
    const rating = Math.round((3.2 + ((h >>> 12) % 18) / 10) * 10) / 10;

    businesses.push({
      id: `mock-${slug}`,
      name,
      address: `${1 + (h % 240)}, ${STREETS[(h >>> 6) % STREETS.length]}, Bengaluru, Karnataka 5600${String((h >>> 10) % 100).padStart(2, '0')}`,
      phone: `+91 ${phoneDigits.slice(0, 5)} ${phoneDigits.slice(5)}`,
      websiteUri: websiteFor(SITE_PATTERN[i % SITE_PATTERN.length], slug, phoneDigits, h),
      googleMapsUri: `https://www.google.com/maps/place/?q=place_id:mock-${slug}`,
      rating,
      ratingCount: 5 + ((h >>> 16) % 896),
      primaryType: type,
      types: [type, 'point_of_interest', 'establishment'],
      businessStatus: h % 17 === 0 ? 'CLOSED_TEMPORARILY' : 'OPERATIONAL',
      location: {
        lat: area.center.lat + (dist * Math.sin(angle)) / METERS_PER_DEG_LAT,
        lng: area.center.lng + (dist * Math.cos(angle)) / metersPerDegLng,
      },
    });
  }
  return businesses;
}

/* ------------------------------------------------------------------ */
/* mockAudit                                                          */
/* ------------------------------------------------------------------ */

const SEVERITY: Partial<Record<WebsiteIssueId, WebsiteIssue['severity']>> = {
  'no-https': 'critical',
  'not-mobile-friendly': 'critical',
  unreachable: 'critical',
  'no-meta-description': 'major',
  'no-title': 'major',
  'slow-response': 'major',
  'outdated-tech': 'major',
  'no-contact-method': 'major',
};

const DETAIL: Partial<Record<WebsiteIssueId, string>> = {
  'not-mobile-friendly':
    'No viewport meta tag — the site renders as a shrunken desktop page on phones.',
  'no-meta-description':
    'Missing meta description, so Google invents its own search snippet.',
  'stale-copyright': 'Footer copyright still says 2021 — the site looks abandoned.',
  'no-https': "Served over plain HTTP; browsers flag it 'Not secure'.",
  'slow-response': 'Server took over 3 seconds to send the first byte.',
  'no-og-tags':
    'No Open Graph tags — links shared on WhatsApp show no preview card.',
  'no-contact-method':
    'No phone number, contact form, or email anywhere on the page.',
};

/** Pool an unhealthy mock site draws 2-5 issues from. */
const WEAK_POOL: WebsiteIssueId[] = [
  'not-mobile-friendly',
  'no-meta-description',
  'stale-copyright',
  'no-https',
  'slow-response',
  'no-og-tags',
  'outdated-tech',
  'no-contact-method',
];

/** 1-2 cosmetic issues so healthy scores land in 80..95, never a flat 100. */
const HEALTHY_VARIANTS: WebsiteIssueId[][] = [
  ['no-og-tags'],
  ['no-og-tags', 'stale-copyright'],
  ['no-meta-description'],
  ['no-meta-description', 'no-og-tags'],
];

function makeIssue(id: WebsiteIssueId, tech?: string): WebsiteIssue {
  const severity = SEVERITY[id] ?? 'minor';
  if (id === 'outdated-tech') {
    return {
      id,
      severity,
      detail:
        tech === 'Wix'
          ? 'Built with Wix on a legacy template that loads slowly and ranks poorly.'
          : 'Built on WordPress 4.9, released in 2017 and no longer receiving patches.',
    };
  }
  return { id, severity, detail: DETAIL[id] ?? `Issue detected: ${id}.` };
}

/** Same formula as score.ts: start 100; critical -25, major -12, minor -5. */
function scoreFromIssues(issues: WebsiteIssue[]): number {
  const penalty = issues.reduce(
    (sum, i) => sum + (i.severity === 'critical' ? 25 : i.severity === 'major' ? 12 : 5),
    0,
  );
  return Math.min(100, Math.max(0, 100 - penalty));
}

const SOCIAL_RE = /facebook\.com|instagram\.com|wa\.me|linktr\.ee/i;

export function mockAudit(url: string): WebsiteAudit {
  const h = fnv1a(url);

  if (SOCIAL_RE.test(url)) {
    const issues: WebsiteIssue[] = [
      {
        id: 'social-only',
        severity: 'critical',
        detail:
          'The only web presence is a social profile — there is no actual website to rank, brand, or convert on.',
      },
    ];
    return {
      url,
      finalUrl: url,
      reachable: true,
      httpStatus: 200,
      https: true,
      responseMs: 150 + (h % 400),
      socialOnly: true,
      issues,
      score: scoreFromIssues(issues),
    };
  }

  if (url.includes('-broken.')) {
    return {
      url,
      reachable: false,
      https: url.startsWith('https://'),
      socialOnly: false,
      issues: [
        {
          id: 'unreachable',
          severity: 'critical',
          detail: 'The domain does not resolve — customers clicking the Google listing hit a dead end.',
        },
      ],
      score: 0,
    };
  }

  const healthy = h % 3 === 0;
  let issueIds: WebsiteIssueId[];
  if (healthy) {
    issueIds = HEALTHY_VARIANTS[(h >>> 5) % HEALTHY_VARIANTS.length];
  } else {
    const count = 2 + ((h >>> 7) % 4); // 2..5
    const start = (h >>> 11) % WEAK_POOL.length;
    const stride = [1, 3, 5, 7][(h >>> 14) % 4]; // coprime to 8 => distinct picks
    issueIds = Array.from(
      { length: count },
      (_, k) => WEAK_POOL[(start + k * stride) % WEAK_POOL.length],
    );
  }

  const hasOutdatedTech = issueIds.includes('outdated-tech');
  const tech = hasOutdatedTech ? (h % 2 === 0 ? 'WordPress 4.9' : 'Wix') : undefined;
  const issues = issueIds.map((id) => makeIssue(id, tech));
  const slow = issueIds.includes('slow-response');
  const insecure = issueIds.includes('no-https');

  return {
    url,
    finalUrl: insecure ? url.replace(/^https:/, 'http:') : url,
    reachable: true,
    httpStatus: 200,
    https: !insecure,
    responseMs: slow ? 3200 + (h % 1800) : 180 + (h % 700),
    htmlBytes: 30_000 + ((h >>> 3) % 250_000),
    socialOnly: false,
    issues,
    score: scoreFromIssues(issues),
    tech,
  };
}
