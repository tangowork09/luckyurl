/**
 * Pipeline orchestrator: search -> audit (concurrency pool) -> classify ->
 * competitor-density pass -> CRM annotate -> optional local drafts -> write
 * files. Emits every ProgressEvent type and ends with 'done'.
 */
import { auditWebsite } from './audit';
import { draftWithEnsemble, ensembleAvailable } from './draft';
import { promptMarkdown, writeLeadFiles } from './markdown';
import { jitter, launchMapsBrowser, readListing } from './maps-live';
import { mockAudit } from './mock';
import { searchBusinesses } from './places';
import { classifyLead, groupKeyOf, withCompetitorContext } from './score';
import type { CrmStore } from './store';
import type {
  AppConfig,
  Business,
  CategoryContext,
  Lead,
  ProgressFn,
  ScanRequest,
  ScanResult,
  WebsiteAudit,
} from './types';

const DEFAULT_AUDIT_CONCURRENCY = 10;
const DRAFT_TOP_N = 10;
const VERIFY_CONCURRENCY = 3;
// Hard ceiling on live-verify targets per scan. Without this, a plan's
// maxBusinesses (up to 2000) times readListing's ~1-2s+ real cost at only 3
// tabs of concurrency turns into a multi-hour foreground wait on a request
// the user is watching a progress bar for. Truncation is logged, never silent.
const MAX_LIVE_VERIFY_TARGETS = 150;
// Data sources whose googleMapsUri actually points at a Google Maps place
// page. OSM's free path stores an openstreetmap.org URL in that same field
// (see overpass.ts) — navigating there would just read OSM's own page, not
// verify anything, so live-verify is skipped rather than fed garbage input.
const LIVE_VERIFY_SOURCES = new Set(['google', 'apify']);

/**
 * Re-checks every business against its live Google Maps page (a headless
 * Chrome pass, not the Places API) and overwrites stale fields in place —
 * website added/removed, phone changed, or the place closed down. The
 * Places API result can lag the live page by weeks; this catches that.
 *
 * Never throws: a Chromium launch failure (e.g. missing OS deps in a
 * container) degrades to "skip live-verify" for the caller to handle, same
 * as every other optional pass in this pipeline — it must not discard an
 * otherwise-successful search + audit, especially after billing has already
 * charged the user's scan quota for this request.
 */
async function revalidateWithLiveMaps(
  businesses: Business[],
  onProgress: ProgressFn | undefined,
  signal: AbortSignal | undefined,
): Promise<void> {
  const allTargets = businesses.filter((b) => b.googleMapsUri);
  if (allTargets.length === 0) return;
  const targets = allTargets.slice(0, MAX_LIVE_VERIFY_TARGETS);
  if (allTargets.length > targets.length) {
    onProgress?.({
      type: 'phase',
      phase: 'search',
      message: `Live-verify capped at ${targets.length}/${allTargets.length} businesses (time budget).`,
    });
  }

  const browser = await launchMapsBrowser(true);
  try {
    let next = 0;
    let done = 0;
    const worker = async () => {
      const page = await browser.newPage();
      try {
        for (;;) {
          if (signal?.aborted) return;
          const i = next++;
          if (i >= targets.length) return;
          const b = targets[i];
          const live = await readListing(page, b.googleMapsUri);
          // Only trust the live read when readListing confirmed it actually
          // landed on a real Maps place page (see isGoogleMapsPlaceUrl) — a
          // non-null result here means "verified," not "best guess," so
          // websiteUri can be overwritten unconditionally same as the other
          // fields: a live page with no site link means no site, full stop.
          if (live) {
            b.websiteUri = live.website;
            if (live.phone) b.phone = live.phone;
            if (live.address) b.address = live.address;
            if (live.closed) {
              b.businessStatus = 'CLOSED_PERMANENTLY';
            } else if (b.businessStatus && b.businessStatus !== 'OPERATIONAL') {
              // Cached data said closed; the live page loaded fine with no
              // closed badge — trust the fresher read and reopen it.
              b.businessStatus = 'OPERATIONAL';
            }
          }
          done++;
          onProgress?.({ type: 'verify', done, total: targets.length, current: b.name });
          await jitter(500); // politeness delay — match places.ts / scrape-maps.ts pacing
        }
      } finally {
        await page.close();
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(VERIFY_CONCURRENCY, targets.length) }, worker),
    );
  } finally {
    await browser.close();
  }
}

export interface ScanOptions {
  /** CRM store for cross-scan dedup, suppression and status annotation. */
  store?: CrmStore;
  /** Abort mid-scan (client disconnected / user cancelled). */
  signal?: AbortSignal;
}

async function auditAll(
  cfg: AppConfig,
  req: ScanRequest,
  withSites: Business[],
  onProgress: ProgressFn | undefined,
  signal: AbortSignal | undefined,
): Promise<Map<string, WebsiteAudit>> {
  const audits = new Map<string, WebsiteAudit>();
  const concurrency = Math.max(1, req.auditConcurrency ?? DEFAULT_AUDIT_CONCURRENCY);
  let next = 0;
  let done = 0;

  const worker = async () => {
    for (;;) {
      if (signal?.aborted) return;
      const i = next++;
      if (i >= withSites.length) return;
      const b = withSites[i];
      const audit = cfg.demoMode
        ? mockAudit(b.websiteUri!)
        : await auditWebsite(b.websiteUri!, {
            pagespeedKey: cfg.pagespeedKey,
            psi: req.psi,
            // Deep runs (PSI on) also HEAD-check links/forms for the strongest pitch hooks.
            checkLinks: req.psi === true,
          });
      audits.set(b.id, audit);
      done++;
      onProgress?.({ type: 'audit', done, total: withSites.length, current: b.name });
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(concurrency, withSites.length) }, worker),
  );
  return audits;
}

/**
 * Build same-category competitive context for every group in one pass, then
 * fold it into each lead's score. "Healthy site" = a business that has a site
 * we audited but which did NOT become a lead.
 */
function applyCompetitorContext(
  leads: Lead[],
  businesses: Business[],
  audits: Map<string, WebsiteAudit>,
  leadIds: Set<string>,
  weights: AppConfig['weights'],
): Lead[] {
  const total = new Map<string, number>();
  const healthy = new Map<string, number>();
  for (const b of businesses) {
    const key = groupKeyOf(b);
    total.set(key, (total.get(key) ?? 0) + 1);
    const audit = audits.get(b.id);
    const isHealthySite = audit && !audit.socialOnly && audit.reachable && !leadIds.has(b.id);
    if (isHealthySite) healthy.set(key, (healthy.get(key) ?? 0) + 1);
  }
  return leads.map((lead) => {
    const key = groupKeyOf(lead.business);
    const context: CategoryContext = {
      total: total.get(key) ?? 1,
      withHealthySite: healthy.get(key) ?? 0,
    };
    return withCompetitorContext(lead, context, weights);
  });
}

async function generateDrafts(
  leads: Lead[],
  onProgress?: ProgressFn,
): Promise<Map<string, string>> {
  const drafts = new Map<string, string>();
  if (!(await ensembleAvailable())) {
    onProgress?.({ type: 'phase', phase: 'write', message: 'ensemble CLI not found — skipping auto-drafts.' });
    return drafts;
  }
  const top = leads.slice(0, DRAFT_TOP_N);
  for (let i = 0; i < top.length; i++) {
    onProgress?.({ type: 'audit', done: i + 1, total: top.length, current: `drafting ${top[i].business.name}` });
    const draft = await draftWithEnsemble(promptMarkdown(top[i]));
    if (draft) drafts.set(top[i].business.id, draft);
  }
  return drafts;
}

export async function runScan(
  cfg: AppConfig,
  req: ScanRequest,
  onProgress?: ProgressFn,
  opts: ScanOptions = {},
): Promise<ScanResult> {
  try {
    const startedAt = new Date().toISOString();
    const { store, signal } = opts;

    onProgress?.({ type: 'phase', phase: 'search', message: 'Searching businesses in the area…' });
    const businesses = await searchBusinesses(cfg, req, onProgress);
    if (signal?.aborted) throw new Error('Scan cancelled.');

    if (req.liveVerify && !cfg.demoMode && LIVE_VERIFY_SOURCES.has(cfg.dataSource)) {
      onProgress?.({
        type: 'phase',
        phase: 'search',
        message: `Revalidating ${businesses.length} businesses against live Google Maps…`,
      });
      try {
        await revalidateWithLiveMaps(businesses, onProgress, signal);
      } catch (err) {
        // A Chromium/infra failure here must not void a search (and billed
        // scan quota) that already succeeded — fall back to cached data.
        onProgress?.({
          type: 'phase',
          phase: 'search',
          message: `Live-verify unavailable (${err instanceof Error ? err.message : String(err)}) — continuing with cached data.`,
        });
      }
      if (signal?.aborted) throw new Error('Scan cancelled.');
    } else if (req.liveVerify && !cfg.demoMode) {
      onProgress?.({
        type: 'phase',
        phase: 'search',
        message: `Live-verify skipped — the ${cfg.dataSource.toUpperCase()} data source has no Google Maps page to verify against.`,
      });
    }

    const withSites = businesses.filter((b) => b.websiteUri);
    onProgress?.({
      type: 'phase',
      phase: 'audit',
      message: `Auditing ${withSites.length} websites (${businesses.length - withSites.length} businesses have none)…`,
    });
    const audits = await auditAll(cfg, req, withSites, onProgress, signal);
    if (signal?.aborted) throw new Error('Scan cancelled.');

    // Classify.
    let leads: Lead[] = [];
    let skipped = 0;
    const leadIds = new Set<string>();
    for (const b of businesses) {
      const lead = classifyLead(b, audits.get(b.id), cfg.weights);
      if (lead) {
        leads.push(lead);
        leadIds.add(b.id);
      } else {
        skipped++;
      }
    }

    // Fold in same-category competitive context, then rank.
    leads = applyCompetitorContext(leads, businesses, audits, leadIds, cfg.weights);
    leads.sort((a, b) => b.leadScore - a.leadScore);

    // CRM: dedup across scans, annotate status/new, drop suppressed businesses.
    let newLeads = leads.length;
    if (store) {
      await store.load();
      const newIds = await store.recordScan(leads, startedAt);
      leads = leads.filter((lead) => {
        const rec = store.get(lead.business.id);
        if (rec?.suppressed) return false; // do-not-contact
        if (rec) {
          lead.status = rec.status;
          lead.tags = rec.tags;
          lead.lastContactedAt = rec.lastContactedAt;
        }
        lead.isNew = newIds.has(lead.business.id);
        return true;
      });
      newLeads = leads.filter((l) => l.isNew).length;
    }

    // Emit leads for the live feed after final ordering/annotation.
    for (const lead of leads) onProgress?.({ type: 'lead', lead });

    // Optional local-model drafts of the top leads.
    let drafts: Map<string, string> | undefined;
    if (req.draft) {
      onProgress?.({ type: 'phase', phase: 'write', message: 'Drafting pitches with the local model…' });
      drafts = await generateDrafts(leads, onProgress);
    }

    onProgress?.({ type: 'phase', phase: 'write', message: `Writing ${leads.length} lead files…` });
    const partial: Omit<ScanResult, 'files' | 'outDir'> = {
      startedAt,
      finishedAt: new Date().toISOString(),
      area: req.area,
      categories: req.categories,
      totalFound: businesses.length,
      audited: audits.size,
      leads,
      skipped,
      newLeads,
    };
    const { files, outDir } = await writeLeadFiles(partial, req.outDir ?? './leads', {
      pack: req.pack,
      drafts,
    });

    const result: ScanResult = { ...partial, files, outDir };
    onProgress?.({ type: 'done', result });
    return result;
  } catch (err) {
    onProgress?.({ type: 'error', message: err instanceof Error ? err.message : String(err) });
    throw err;
  }
}
