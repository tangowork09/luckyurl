import type { CategoryGroup } from './types';

/**
 * Category groups offered in the UI/CLI. Types are Google Places API (New)
 * place types. One searchNearby call is made per (grid cell x group).
 */
export const CATEGORY_GROUPS: CategoryGroup[] = [
  {
    key: 'food',
    label: 'Food & Drink',
    types: [
      'restaurant', 'cafe', 'bakery', 'bar', 'meal_takeaway', 'meal_delivery',
      'coffee_shop', 'ice_cream_shop', 'fast_food_restaurant',
    ],
  },
  {
    key: 'retail',
    label: 'Retail & Shops',
    types: [
      'clothing_store',
      'shoe_store',
      'jewelry_store',
      'furniture_store',
      'electronics_store',
      'hardware_store',
      'book_store',
      'gift_shop',
      'florist',
      'convenience_store',
      'pet_store',
      'sporting_goods_store',
      'toy_store',
      'cell_phone_store',
      'bicycle_store',
      'optician',
      'stationery_store',
    ],
  },
  {
    key: 'grocery',
    label: 'Grocery & Food Retail',
    types: ['supermarket', 'grocery_store', 'liquor_store', 'butcher_shop', 'greengrocer', 'market'],
  },
  {
    key: 'health',
    label: 'Health',
    types: [
      'dentist', 'doctor', 'physiotherapist', 'pharmacy', 'veterinary_care',
      'hospital', 'optometrist', 'medical_lab', 'nursing_home',
    ],
  },
  {
    key: 'beauty',
    label: 'Beauty & Wellness',
    types: ['beauty_salon', 'hair_salon', 'barber_shop', 'spa', 'nail_salon', 'tattoo_parlor'],
  },
  {
    key: 'fitness',
    label: 'Fitness',
    types: ['gym', 'yoga_studio', 'dance_school', 'martial_arts', 'swimming_pool'],
  },
  {
    key: 'professional',
    label: 'Professional Services',
    types: [
      'lawyer', 'accounting', 'insurance_agency', 'real_estate_agency', 'travel_agency',
      'architect', 'consultant', 'marketing_agency',
    ],
  },
  {
    key: 'education',
    label: 'Education & Coaching',
    types: ['school', 'primary_school', 'secondary_school', 'university', 'preschool', 'tutoring_center', 'child_care_agency'],
  },
  {
    key: 'lodging',
    label: 'Lodging',
    types: ['hotel', 'motel', 'guest_house', 'resort_hotel', 'bed_and_breakfast', 'hostel'],
  },
  {
    key: 'entertainment',
    label: 'Entertainment & Events',
    types: ['movie_theater', 'night_club', 'bowling_alley', 'amusement_center', 'event_venue', 'banquet_hall', 'tourist_attraction'],
  },
  {
    key: 'home',
    label: 'Home & Trade Services',
    types: [
      'plumber', 'electrician', 'painter', 'locksmith', 'moving_company', 'laundry',
      'carpenter', 'roofing_contractor', 'general_contractor', 'interior_designer',
    ],
  },
  {
    key: 'auto',
    label: 'Auto',
    types: ['car_repair', 'car_dealer', 'car_wash', 'motorcycle_dealer', 'tire_shop', 'auto_parts_store'],
  },
];

export const ALL_TYPES: string[] = CATEGORY_GROUPS.flatMap((g) => g.types);

/** High-value categories: boost lead score — bigger budgets, higher LTV. */
export const HIGH_VALUE_TYPES = new Set([
  'dentist',
  'doctor',
  'lawyer',
  'accounting',
  'insurance_agency',
  'real_estate_agency',
  'hospital',
  'hotel',
  'resort_hotel',
  'university',
  'school',
  'architect',
]);

/**
 * Relative willingness/ability to pay for web work, tuned for the Indian
 * local-business market. 1.0 = baseline. Drives category-value scoring and the
 * ₹ estimate in score.ts. Keyed by Google-Places-style type (what Business
 * carries after mapping from any source). Unlisted types default to 1.0.
 */
export const CATEGORY_VALUE: Record<string, number> = {
  // High web spend — a single client repays the site many times over.
  dentist: 2.0,
  doctor: 1.9,
  lawyer: 1.9,
  real_estate_agency: 1.9,
  accounting: 1.7,
  insurance_agency: 1.7,
  physiotherapist: 1.5,
  veterinary_care: 1.4,
  spa: 1.4,
  jewelry_store: 1.5,
  car_dealer: 1.5,
  travel_agency: 1.3,
  gym: 1.2,
  yoga_studio: 1.2,
  beauty_salon: 1.2,
  hair_salon: 1.1,
  furniture_store: 1.2,
  electronics_store: 1.2,
  restaurant: 1.1,
  bar: 1.1,
  clothing_store: 1.1,
  // Lower discretionary web budgets.
  cafe: 0.9,
  bakery: 0.9,
  barber_shop: 0.8,
  convenience_store: 0.6,
  meal_takeaway: 0.8,
  car_wash: 0.8,
  laundry: 0.8,
  pharmacy: 0.9,

  // New groups.
  hotel: 1.9,
  resort_hotel: 2.0,
  guest_house: 1.4,
  bed_and_breakfast: 1.4,
  hostel: 1.2,
  school: 1.7,
  secondary_school: 1.7,
  university: 1.9,
  preschool: 1.5,
  tutoring_center: 1.6, // India coaching market — high web intent
  hospital: 1.9,
  optometrist: 1.4,
  medical_lab: 1.5,
  nursing_home: 1.5,
  architect: 1.7,
  consultant: 1.5,
  marketing_agency: 1.6,
  interior_designer: 1.6,
  event_venue: 1.6,
  banquet_hall: 1.7,
  movie_theater: 1.2,
  night_club: 1.2,
  supermarket: 1.0,
  grocery_store: 0.7,
  liquor_store: 0.8,
  butcher_shop: 0.7,
  nail_salon: 1.1,
  tattoo_parlor: 1.2,
  dance_school: 1.2,
  martial_arts: 1.2,
  motorcycle_dealer: 1.3,
  tire_shop: 0.9,
  sporting_goods_store: 1.1,
  cell_phone_store: 1.0,
  bicycle_store: 1.0,
};

/** Baseline ₹ project value (INR) for a "1.0" category, no-website lead. */
export const BASE_PROJECT_VALUE_INR = 20_000;

/**
 * National chains / franchises: rarely buy web work from a local freelancer
 * (marketing is run centrally). Matched case-insensitively as a substring of
 * the business name, so "Domino's Pizza Indiranagar" is caught. Down-ranked,
 * not dropped — a franchisee occasionally wants a microsite.
 */
export const NATIONAL_CHAINS: string[] = [
  "domino's", 'dominos', 'pizza hut', 'kfc', "mcdonald's", 'mcdonalds', 'burger king',
  'subway', 'starbucks', "dunkin", 'costa coffee', 'cafe coffee day', 'ccd', 'chai point',
  'chaayos', 'wow! momo', 'wow momo', "haldiram", 'bikanervala', 'faasos', 'behrouz',
  'apollo pharmacy', 'apollo', 'medplus', 'wellness forever', 'tata 1mg', 'netmeds',
  'reliance', 'dmart', 'more supermarket', 'spencer', 'big bazaar', 'vishal mega mart',
  'lenskart', 'titan', 'tanishq', 'kalyan jewellers', 'malabar gold', 'joyalukkas',
  'lakme salon', 'naturals salon', 'green trends', 'jawed habib', 'toni & guy',
  'cult.fit', 'cultfit', "gold's gym", 'anytime fitness', 'decathlon',
  'first cry', 'firstcry', 'croma', 'reliance digital', 'vijay sales',
];

/** True when a business name matches a known national chain/franchise. */
export function isNationalChain(name: string): boolean {
  const n = name.toLowerCase();
  return NATIONAL_CHAINS.some((c) => n.includes(c));
}
