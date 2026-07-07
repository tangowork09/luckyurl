/**
 * Live Google Maps scraper — bypasses the Places API entirely (no quota, no
 * key), so results reflect what Maps shows *right now* instead of a stale
 * cached dataset. Use when the Places API quota is exhausted or its data
 * looks out of date.
 *
 * Usage:
 *   npm run scrape:maps -- --query "restaurants" --location "Koramangala, Bangalore" [--max 60] [--show] [--out ./leads]
 *   npm run scrape:maps -- --query "salons" --lat 12.9352 --lng 77.6146 --zoom 14
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  acceptConsentIfPresent,
  collectListingUrls,
  jitter,
  launchMapsBrowser,
  readListing,
  type LiveListing,
} from './maps-live';

interface ScrapedBusiness extends LiveListing {
  mapsUrl: string;
  hasWebsite: boolean;
}

function parseArgs(argv: string[]): Map<string, string | true> {
  const args = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      args.set(key, next);
      i++;
    } else {
      args.set(key, true);
    }
  }
  return args;
}

function fail(message: string): never {
  console.error(`Error: ${message}`);
  console.error(
    'Usage: npm run scrape:maps -- --query "restaurants" --location "Koramangala, Bangalore" ' +
      '[--lat 12.93 --lng 77.61] [--zoom 14] [--max 60] [--show] [--out ./leads]',
  );
  process.exit(1);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const query = args.get('query');
  if (typeof query !== 'string' || !query.trim()) fail('--query is required.');

  const location = typeof args.get('location') === 'string' ? (args.get('location') as string) : '';
  const lat = typeof args.get('lat') === 'string' ? Number(args.get('lat')) : undefined;
  const lng = typeof args.get('lng') === 'string' ? Number(args.get('lng')) : undefined;
  const zoom = typeof args.get('zoom') === 'string' ? Number(args.get('zoom')) : 14;
  const max = typeof args.get('max') === 'string' ? Math.min(Number(args.get('max')), 200) : 60;
  const headless = !args.has('show');
  const outDir = typeof args.get('out') === 'string' ? (args.get('out') as string) : './leads';

  const searchText = location ? `${query} in ${location}` : (query as string);
  const searchUrl =
    lat !== undefined && lng !== undefined
      ? `https://www.google.com/maps/search/${encodeURIComponent(searchText)}/@${lat},${lng},${zoom}z`
      : `https://www.google.com/maps/search/${encodeURIComponent(searchText)}`;

  console.log(`LeadScout Maps scrape — "${searchText}" (max ${max}, headless=${headless})`);

  const browser = await launchMapsBrowser(headless);
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await acceptConsentIfPresent(page);

    const urls = await collectListingUrls(page, max);
    console.log(`Found ${urls.length} listings in the feed — reading each...`);

    const results: ScrapedBusiness[] = [];
    for (let i = 0; i < urls.length; i++) {
      const biz = await readListing(page, urls[i]);
      if (biz) {
        results.push({ ...biz, mapsUrl: urls[i], hasWebsite: !!biz.website });
        console.log(
          `   ${String(i + 1).padStart(3)}/${urls.length}  ${biz.website ? 'has site' : 'NO SITE '}  ${biz.name}`,
        );
      }
      await jitter(700);
    }

    const noWebsite = results.filter((r) => !r.hasWebsite);

    const dir = resolve(outDir, `maps-scrape-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(resolve(dir, 'results.json'), JSON.stringify(results, null, 2));
    writeFileSync(resolve(dir, 'no-website.json'), JSON.stringify(noWebsite, null, 2));

    console.log('\n================ RESULTS ================');
    console.log(`Scraped ${results.length} businesses · ${noWebsite.length} with no website\n`);
    console.log('Business                             Phone            Address');
    console.log('------------------------------------ ---------------- ------------------------------');
    for (const b of noWebsite) {
      console.log(
        `${(b.name ?? '').slice(0, 37).padEnd(37)} ${(b.phone ?? '').padEnd(16)} ${(b.address ?? '').slice(0, 30)}`,
      );
    }
    console.log(`\nSaved: ${dir}`);
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
