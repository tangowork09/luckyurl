/**
 * Headless scans:
 *   npm run scan -- --lat 12.9758 --lng 77.6045 --radius 2000 \
 *     [--categories food,retail] [--max 300] [--psi] [--live-verify] [--out ./leads] [--demo]
 */
import { resolve } from 'node:path';
import { loadConfig } from './config';
import { runScan } from './scan';
import { CrmStore } from './store';
import type { Lead, ProgressEvent, ScanRequest } from './types';

const DEFAULT_CENTER = { lat: 12.9758, lng: 77.6045 };

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

function numArg(args: Map<string, string | true>, key: string): number | undefined {
  const v = args.get(key);
  if (typeof v !== 'string') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function fail(message: string): never {
  console.error(`Error: ${message}`);
  console.error(
    'Usage: npm run scan -- --lat <lat> --lng <lng> [--radius 2000] ' +
      '[--categories food,retail] [--max 300] [--psi] [--live-verify] [--pack 10] [--draft] [--out ./leads] [--demo]',
  );
  process.exit(1);
}

const KIND_TAG: Record<Lead['kind'], string> = {
  'no-website': 'NO SITE ',
  'broken-website': 'BROKEN  ',
  'needs-improvement': 'IMPROVE ',
};

function onProgress(e: ProgressEvent): void {
  switch (e.type) {
    case 'phase':
      console.log(`\n== ${e.message}`);
      break;
    case 'search':
      console.log(`   cell ${e.cell}/${e.cells} — ${e.found} businesses found`);
      break;
    case 'verify':
      console.log(`   verify ${e.done}/${e.total} — ${e.current}`);
      break;
    case 'audit':
      console.log(`   audit ${e.done}/${e.total} — ${e.current}`);
      break;
    case 'lead':
      console.log(
        `   + [${KIND_TAG[e.lead.kind]}] ${String(e.lead.leadScore).padStart(2)}  ${e.lead.business.name}`,
      );
      break;
    case 'error':
      console.error(`   ! ${e.message}`);
      break;
    case 'done':
      break; // summary printed by main()
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const cfg = loadConfig();
  if (args.has('demo')) {
    cfg.dataSource = 'demo';
    cfg.demoMode = true;
  }

  let lat = numArg(args, 'lat');
  let lng = numArg(args, 'lng');
  if (lat === undefined || lng === undefined) {
    if (!cfg.demoMode) fail('--lat and --lng are required (or use --demo).');
    lat = DEFAULT_CENTER.lat;
    lng = DEFAULT_CENTER.lng;
  }
  if (lat < -90 || lat > 90) fail(`--lat out of range: ${lat}`);
  if (lng < -180 || lng > 180) fail(`--lng out of range: ${lng}`);

  const radius = numArg(args, 'radius') ?? 2000;
  if (radius < 100 || radius > 50_000) fail(`--radius must be 100..50000, got ${radius}`);

  const categoriesArg = args.get('categories');
  const categories =
    typeof categoriesArg === 'string'
      ? categoriesArg.split(',').map((c) => c.trim()).filter(Boolean)
      : [];

  const outDir = typeof args.get('out') === 'string' ? (args.get('out') as string) : './leads';
  const req: ScanRequest = {
    area: { center: { lat, lng }, radiusMeters: radius },
    categories,
    psi: args.has('psi'),
    draft: args.has('draft'),
    liveVerify: args.has('live-verify'),
    outDir,
  };
  const max = numArg(args, 'max');
  if (max !== undefined) req.maxBusinesses = Math.min(Math.max(Math.floor(max), 1), 2000);
  const pack = numArg(args, 'pack');
  if (pack !== undefined && pack > 0) req.pack = Math.min(Math.floor(pack), 50);

  // Share one CRM store so repeat CLI scans dedup and remember status.
  const store = new CrmStore(resolve(outDir));

  console.log(
    `LeadScout scan — ${lat.toFixed(4)}, ${lng.toFixed(4)} r=${radius}m ` +
      `categories=${categories.length ? categories.join(',') : 'all'} ` +
      `[source: ${cfg.dataSource.toUpperCase()}]`,
  );

  const result = await runScan(cfg, req, onProgress, { store });

  console.log('\n================ RESULTS ================');
  console.log(
    `Found ${result.totalFound} businesses · audited ${result.audited} sites · ` +
      `${result.leads.length} leads · ${result.skipped} healthy`,
  );
  console.log('\nScore  Kind      Business                            Phone');
  console.log('-----  --------  ----------------------------------  ---------------');
  for (const lead of result.leads) {
    console.log(
      `${String(lead.leadScore).padStart(5)}  ${KIND_TAG[lead.kind]}  ` +
        `${lead.business.name.slice(0, 34).padEnd(34)}  ${lead.business.phone ?? ''}`,
    );
  }
  console.log(`\nLead files: ${result.outDir}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
