/**
 * OpenStreetMap Overpass data source — the free, no-key, no-card path.
 *
 * OSM data is ODbL open-licensed, so querying and storing it for lead
 * generation is fine. Trade-offs vs Google Places: no ratings/review counts
 * (popularity bonus in scoring becomes 0) and thinner coverage of small
 * shops, especially outside big cities.
 */
import { normalizeIndianPhone } from './phone';
import type { Business, ProgressFn, ScanRequest } from './types';

const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];
// Public Overpass instances 406/429 anonymous clients — identify ourselves.
const USER_AGENT = 'LeadScout/0.1 (local lead research tool)';
const REQUEST_TIMEOUT_MS = 60_000;
const RETRY_DELAY_MS = 2_000;
const DEFAULT_MAX_BUSINESSES = 300;

type OsmTagKey = 'amenity' | 'shop' | 'office' | 'leisure' | 'craft' | 'healthcare' | 'tourism';

/** Category group key -> OSM tag selectors (mirrors categories.ts groups). */
const GROUP_SELECTORS: Record<string, Partial<Record<OsmTagKey, string[]>>> = {
  food: {
    amenity: ['restaurant', 'cafe', 'fast_food', 'bar', 'pub', 'ice_cream', 'food_court'],
    shop: ['bakery', 'confectionery', 'coffee'],
  },
  retail: {
    shop: [
      'clothes', 'shoes', 'jewelry', 'furniture', 'electronics', 'hardware',
      'doityourself', 'books', 'gift', 'florist', 'convenience', 'pet',
      'sports', 'toys', 'mobile_phone', 'bicycle', 'optician', 'stationery',
      'variety_store', 'department_store',
    ],
  },
  grocery: {
    shop: ['supermarket', 'grocery', 'greengrocer', 'butcher', 'alcohol', 'general', 'dairy', 'kiosk'],
    amenity: ['marketplace'],
  },
  health: {
    amenity: ['dentist', 'doctors', 'clinic', 'pharmacy', 'veterinary', 'hospital'],
    healthcare: ['physiotherapist', 'laboratory', 'optometrist', 'nursing_home'],
    shop: ['optician', 'medical_supply'],
  },
  beauty: { shop: ['beauty', 'hairdresser', 'massage', 'nails', 'tattoo'] },
  fitness: {
    leisure: ['fitness_centre', 'sports_centre', 'dance', 'swimming_pool'],
  },
  professional: {
    office: [
      'lawyer', 'accountant', 'insurance', 'estate_agent', 'travel_agent',
      'financial_advisor', 'architect', 'consulting', 'advertising_agency', 'it',
    ],
    shop: ['travel_agency'],
  },
  education: {
    amenity: ['school', 'university', 'college', 'kindergarten', 'language_school', 'music_school', 'prep_school'],
    office: ['educational_institution'],
  },
  lodging: {
    tourism: ['hotel', 'motel', 'guest_house', 'hostel', 'resort', 'apartment'],
  },
  entertainment: {
    amenity: ['cinema', 'nightclub', 'theatre', 'events_venue'],
    leisure: ['bowling_alley', 'amusement_arcade', 'escape_game'],
    tourism: ['attraction', 'museum'],
  },
  home: {
    craft: ['plumber', 'electrician', 'painter', 'key_cutter', 'carpenter', 'roofer', 'tiler', 'interior_decorator', 'builder'],
    shop: ['laundry', 'dry_cleaning', 'locksmith', 'interior_decoration'],
    office: ['contractor'],
  },
  auto: {
    shop: ['car_repair', 'car', 'motorcycle', 'tyres', 'car_parts', 'motorcycle_repair'],
    amenity: ['car_wash', 'fuel'],
  },
};

/** OSM tag value -> Google-Places-style type, so scoring/labels stay unified. */
const TYPE_FROM_TAG: Record<string, string> = {
  restaurant: 'restaurant', cafe: 'cafe', fast_food: 'meal_takeaway', bar: 'bar',
  pub: 'bar', ice_cream: 'ice_cream_shop', food_court: 'meal_takeaway',
  bakery: 'bakery', confectionery: 'bakery', coffee: 'coffee_shop',
  clothes: 'clothing_store', shoes: 'shoe_store', jewelry: 'jewelry_store',
  furniture: 'furniture_store', electronics: 'electronics_store',
  hardware: 'hardware_store', doityourself: 'hardware_store', books: 'book_store',
  gift: 'gift_shop', florist: 'florist', convenience: 'convenience_store', pet: 'pet_store',
  sports: 'sporting_goods_store', toys: 'toy_store', mobile_phone: 'cell_phone_store',
  bicycle: 'bicycle_store', stationery: 'stationery_store', variety_store: 'convenience_store',
  department_store: 'clothing_store',
  supermarket: 'supermarket', grocery: 'grocery_store', greengrocer: 'greengrocer',
  butcher: 'butcher_shop', alcohol: 'liquor_store', general: 'grocery_store',
  dairy: 'grocery_store', kiosk: 'convenience_store', marketplace: 'market',
  dentist: 'dentist', doctors: 'doctor', clinic: 'doctor', pharmacy: 'pharmacy',
  veterinary: 'veterinary_care', physiotherapist: 'physiotherapist', hospital: 'hospital',
  laboratory: 'medical_lab', optometrist: 'optometrist', optician: 'optometrist',
  nursing_home: 'nursing_home', medical_supply: 'pharmacy',
  beauty: 'beauty_salon', hairdresser: 'hair_salon', massage: 'spa',
  nails: 'nail_salon', tattoo: 'tattoo_parlor',
  fitness_centre: 'gym', sports_centre: 'gym', dance: 'dance_school',
  swimming_pool: 'swimming_pool',
  lawyer: 'lawyer', accountant: 'accounting', insurance: 'insurance_agency',
  estate_agent: 'real_estate_agency', travel_agent: 'travel_agency',
  travel_agency: 'travel_agency', financial_advisor: 'accounting',
  architect: 'architect', consulting: 'consultant', advertising_agency: 'marketing_agency',
  it: 'consultant',
  school: 'school', university: 'university', college: 'university',
  kindergarten: 'preschool', language_school: 'tutoring_center',
  music_school: 'tutoring_center', prep_school: 'tutoring_center',
  educational_institution: 'tutoring_center',
  hotel: 'hotel', motel: 'motel', guest_house: 'guest_house', hostel: 'hostel',
  resort: 'resort_hotel', apartment: 'guest_house',
  cinema: 'movie_theater', nightclub: 'night_club', theatre: 'event_venue',
  events_venue: 'event_venue', bowling_alley: 'bowling_alley',
  amusement_arcade: 'amusement_center', escape_game: 'amusement_center',
  attraction: 'tourist_attraction', museum: 'tourist_attraction',
  plumber: 'plumber', electrician: 'electrician', painter: 'painter',
  key_cutter: 'locksmith', locksmith: 'locksmith', carpenter: 'carpenter',
  roofer: 'roofing_contractor', tiler: 'general_contractor', builder: 'general_contractor',
  interior_decorator: 'interior_designer', interior_decoration: 'interior_designer',
  contractor: 'general_contractor',
  laundry: 'laundry', dry_cleaning: 'laundry',
  car_repair: 'car_repair', car: 'car_dealer', motorcycle: 'motorcycle_dealer',
  tyres: 'tire_shop', car_parts: 'auto_parts_store', motorcycle_repair: 'car_repair',
  car_wash: 'car_wash', fuel: 'car_wash',
};

export interface OsmElement {
  type: 'node' | 'way' | 'relation';
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}

/** Merge selected groups' selectors into one map of tagKey -> Set of values. */
function mergeSelectors(categories: string[]): Map<OsmTagKey, Set<string>> {
  const keys = categories.length > 0
    ? categories.filter((c) => c in GROUP_SELECTORS)
    : Object.keys(GROUP_SELECTORS);
  const merged = new Map<OsmTagKey, Set<string>>();
  for (const key of keys.length > 0 ? keys : Object.keys(GROUP_SELECTORS)) {
    for (const [tagKey, values] of Object.entries(GROUP_SELECTORS[key])) {
      const set = merged.get(tagKey as OsmTagKey) ?? new Set<string>();
      for (const v of values ?? []) set.add(v);
      merged.set(tagKey as OsmTagKey, set);
    }
  }
  return merged;
}

export function buildOverpassQuery(req: ScanRequest): string {
  const { lat, lng } = req.area.center;
  const around = `around:${Math.round(req.area.radiusMeters)},${lat},${lng}`;
  const selectors = mergeSelectors(req.categories);
  const clauses = [...selectors.entries()].map(
    ([tagKey, values]) => `  nwr["${tagKey}"~"^(${[...values].join('|')})$"](${around});`,
  );
  return `[out:json][timeout:${REQUEST_TIMEOUT_MS / 1000}];\n(\n${clauses.join('\n')}\n);\nout center tags;`;
}

function composeAddress(tags: Record<string, string>): string {
  const parts = [
    [tags['addr:housenumber'], tags['addr:street']].filter(Boolean).join(' '),
    tags['addr:suburb'] ?? tags['addr:neighbourhood'],
    tags['addr:city'],
    tags['addr:postcode'],
  ].filter(Boolean);
  return parts.join(', ');
}

/** Pure element -> Business mapper; null for unnamed or unlocated elements. */
export function osmToBusiness(el: OsmElement): Business | null {
  const tags = el.tags ?? {};
  const name = tags.name;
  const lat = el.lat ?? el.center?.lat;
  const lng = el.lon ?? el.center?.lon;
  if (!name || typeof lat !== 'number' || typeof lng !== 'number') return null;

  const tagValue =
    tags.amenity ?? tags.shop ?? tags.office ?? tags.leisure ?? tags.craft ?? tags.healthcare ?? tags.tourism;
  const primaryType = (tagValue && TYPE_FROM_TAG[tagValue]) || tagValue;

  // A Facebook/Instagram-only contact still goes into websiteUri: the audit
  // flags it social-only, which is exactly the lead signal we want.
  const websiteUri =
    tags.website ?? tags['contact:website'] ?? tags['contact:facebook'] ?? tags['contact:instagram'];

  const disused = tags.disused === 'yes' || Object.keys(tags).some((k) => k.startsWith('disused:'));
  const phone = tags.phone ?? tags['contact:phone'] ?? tags['contact:mobile'];
  const norm = normalizeIndianPhone(phone);
  const email = tags.email ?? tags['contact:email'];

  const business: Business = {
    id: `osm-${el.type}-${el.id}`,
    name,
    address: composeAddress(tags),
    phone,
    websiteUri,
    googleMapsUri: `https://www.openstreetmap.org/${el.type}/${el.id}`,
    primaryType,
    types: primaryType ? [primaryType] : [],
    businessStatus: disused ? 'CLOSED_PERMANENTLY' : 'OPERATIONAL',
    location: { lat, lng },
    // OSM has no ratings; approximate "established" from tag richness so the
    // free path doesn't score every lead identically. See score.ts.
    maturity: osmMaturity(tags),
  };
  if (norm.e164) business.phoneE164 = norm.e164;
  if (norm.whatsappUri) business.whatsappUri = norm.whatsappUri;
  if (email) business.email = email;
  return business;
}

/**
 * 0..100 establishment-maturity proxy from OSM signal richness. A shop with
 * hours, phone, cuisine/brand and a full address is a real, running business;
 * a bare unnamed node is not. Used only when a Google rating is absent.
 */
function osmMaturity(tags: Record<string, string>): number {
  let score = 0;
  if (tags.opening_hours) score += 25;
  if (tags.phone || tags['contact:phone'] || tags['contact:mobile']) score += 20;
  if (tags.email || tags['contact:email']) score += 10;
  if (tags['addr:street'] && tags['addr:housenumber']) score += 20;
  if (tags.cuisine || tags.brand || tags.operator) score += 15;
  if (tags.wheelchair || tags.outdoor_seating || tags.takeaway || tags.delivery) score += 10;
  return Math.min(100, score);
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function queryOverpass(query: string): Promise<OsmElement[]> {
  const errors: string[] = [];
  // Two rounds over the mirror list: transient 429s often clear in seconds.
  for (let round = 0; round < 2; round++) {
    if (round > 0) await sleep(RETRY_DELAY_MS);
    for (const endpoint of OVERPASS_ENDPOINTS) {
      try {
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'User-Agent': USER_AGENT,
          },
          body: `data=${encodeURIComponent(query)}`,
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        if (!res.ok) {
          errors.push(`${endpoint}: HTTP ${res.status}`);
          continue; // 406/429/504 on public servers — try the next mirror
        }
        const data = (await res.json()) as { elements?: OsmElement[] };
        return data.elements ?? [];
      } catch (err) {
        errors.push(`${endpoint}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  throw new Error(`Overpass API unreachable (all mirrors failed): ${errors.join(' | ')}`);
}

export async function searchOsmBusinesses(
  req: ScanRequest,
  onProgress?: ProgressFn,
): Promise<Business[]> {
  const max = req.maxBusinesses ?? DEFAULT_MAX_BUSINESSES;
  const elements = await queryOverpass(buildOverpassQuery(req));

  const unique = new Map<string, Business>();
  for (const el of elements) {
    const business = osmToBusiness(el);
    if (business && !unique.has(business.id)) unique.set(business.id, business);
    if (unique.size >= max) break;
  }

  onProgress?.({ type: 'search', found: unique.size, cell: 1, cells: 1 });
  return [...unique.values()];
}
