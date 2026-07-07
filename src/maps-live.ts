/**
 * Shared headless-Chrome primitives for reading live Google Maps listing
 * pages. Used by scrape-maps.ts (standalone CLI scrape) and scan.ts (live
 * revalidation pass, see LiveListing / readListing).
 *
 * Google's Maps markup is unversioned and can change; selectors here favor
 * `data-item-id` attributes since those are the most stable hooks available.
 * Extraction degrades to `undefined` fields rather than throwing.
 *
 * readListing() only trusts what it extracts when the page it actually landed
 * on (post-redirect, post-consent) is a real Google Maps place page — a wrong
 * URL (an OSM node page, a consent wall, a captcha/"unusual traffic" redirect)
 * looks the same as "no website" if we don't check, and the caller in scan.ts
 * treats a non-null result as ground truth. See isGoogleMapsPlaceUrl.
 */
import puppeteer, { type Browser, type Page } from 'puppeteer';
import { assertPublicUrl } from './safeurl';

export interface LiveListing {
  name?: string;
  category?: string;
  address?: string;
  phone?: string;
  rating?: number;
  reviewCount?: number;
  website?: string;
  /** True when the listing's own title block shows a "Permanently closed" badge. */
  closed?: boolean;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
export const jitter = (baseMs: number) => sleep(baseMs + Math.random() * baseMs * 0.5);

/**
 * Server-wide cap on concurrently open Chromium instances. This app is a
 * single Node process serving every tenant (see server.ts's scanRunning
 * comment) — the per-user scan lock only stops one user from double-running,
 * it does nothing to stop N different users each spawning their own
 * ~150-300MB Chromium process at the same time. This queue makes that a
 * queue instead of an OOM risk. Tune to the container's actual RAM budget.
 */
const MAX_CONCURRENT_BROWSERS = 2;
let activeBrowsers = 0;
const browserWaiters: Array<() => void> = [];

async function acquireBrowserSlot(): Promise<void> {
  if (activeBrowsers < MAX_CONCURRENT_BROWSERS) {
    activeBrowsers++;
    return;
  }
  await new Promise<void>((resolve) => browserWaiters.push(resolve));
}

/** Hands the freed slot straight to the next waiter instead of decrementing then racing. */
function releaseBrowserSlot(): void {
  const next = browserWaiters.shift();
  if (next) {
    next();
  } else {
    activeBrowsers--;
  }
}

export async function launchMapsBrowser(headless = true): Promise<Browser> {
  await acquireBrowserSlot();
  let browser: Browser;
  try {
    // --no-sandbox: this image runs the process as root (no USER directive
    // in the Dockerfile) and Chromium refuses its own sandbox as root.
    // Acceptable here because this browser only ever navigates to Google
    // Maps URLs we already validate (see isGoogleMapsPlaceUrl / assertPublicUrl)
    // — it never renders arbitrary user-uploaded content.
    browser = await puppeteer.launch({
      headless,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
  } catch (err) {
    releaseBrowserSlot();
    throw err;
  }
  const originalClose = browser.close.bind(browser);
  let released = false;
  browser.close = (async () => {
    try {
      return await originalClose();
    } finally {
      if (!released) {
        released = true;
        releaseBrowserSlot();
      }
    }
  }) as Browser['close'];
  return browser;
}

export async function acceptConsentIfPresent(page: Page): Promise<void> {
  if (!/consent\.google\.com/.test(page.url())) return;
  try {
    const clicked = await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('button'));
      const btn = buttons.find((b) => /accept all|i agree/i.test(b.textContent ?? ''));
      if (btn) {
        (btn as HTMLButtonElement).click();
        return true;
      }
      return false;
    });
    if (clicked) await sleep(1500);
  } catch {
    // Best-effort; if consent isn't there, proceed normally.
  }
}

/**
 * True only for an actual Google Maps page (any google.* host, /maps/ path).
 * Deliberately excludes consent.google.com (path is /ml, not /maps/) and any
 * non-Google host (e.g. openstreetmap.org — OSM-sourced businesses carry an
 * OSM URL in the same googleMapsUri field, not a real Maps page) or a
 * "/sorry/..." anti-abuse redirect. Checked against page.url() AFTER
 * navigation (+ consent handling), since that's the actual landing spot —
 * the requested URL can differ once redirects run.
 */
function isGoogleMapsPlaceUrl(rawUrl: string): boolean {
  try {
    const u = new URL(rawUrl);
    return /(^|\.)google\.[a-z.]+$/i.test(u.hostname) && u.pathname.includes('/maps/');
  } catch {
    return false;
  }
}

export async function collectListingUrls(page: Page, max: number): Promise<string[]> {
  await page.waitForSelector('div[role="feed"]', { timeout: 20_000 });
  const urls = new Set<string>();
  let stableRounds = 0;

  while (urls.size < max && stableRounds < 4) {
    const found = await page.$$eval('div[role="feed"] a', (as) =>
      as
        .map((a) => a.getAttribute('href'))
        .filter((h): h is string => !!h && h.includes('/maps/place/')),
    );
    const before = urls.size;
    for (const h of found) urls.add(h);
    stableRounds = urls.size === before ? stableRounds + 1 : 0;

    await page.evaluate(() => {
      const feed = document.querySelector('div[role="feed"]');
      if (feed) feed.scrollTop = feed.scrollHeight;
    });
    await jitter(1200);
  }

  return [...urls].slice(0, max);
}

/**
 * Navigates `page` to a Maps place URL and reads its current details.
 * Returns null (never throws) when the target isn't public, isn't reachable,
 * or the page we land on isn't actually a Google Maps place page — callers
 * treat a non-null result as ground truth, so a wrong/blocked page must come
 * back as "couldn't verify," not as fabricated data.
 */
export async function readListing(page: Page, url: string): Promise<LiveListing | null> {
  try {
    // Reject loopback/private/link-local/metadata targets before ever
    // spending a browser navigation on them. This is a best-effort check —
    // it validates the URL we were given, but Chromium resolves DNS again
    // itself on navigation and follows redirects internally, so it does not
    // re-validate every hop the way safeFetch does for plain HTTP fetches.
    // Google Maps URLs are always public hosts in practice; this mainly
    // guards against a malformed/malicious googleMapsUri from a third-party
    // data source (e.g. a compromised Apify actor) before it reaches a
    // browser at all.
    await assertPublicUrl(url);
  } catch {
    return null;
  }

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20_000 });
    await acceptConsentIfPresent(page); // may navigate onward to the real destination

    const finalUrl = page.url();
    if (!isGoogleMapsPlaceUrl(finalUrl)) return null;

    await page.waitForSelector('h1', { timeout: 15_000 });
    await jitter(400);

    // Inlined on purpose: page.evaluate serializes only this function's own
    // source text into the browser context, so it can't call back out to
    // named helpers defined elsewhere in this module (esbuild wraps them in
    // a `__name` helper that doesn't exist on that side).
    return await page.evaluate(() => {
      const h1 = document.querySelector('h1');
      const name = h1?.textContent?.trim() || undefined;

      // Scoped to h1's immediate parent (the title block) on purpose — a
      // whole-document text search also matches unrelated closure badges
      // further down the page (Google's "People also search for" carousel
      // routinely shows OTHER nearby places marked "Permanently closed").
      // Missing a real closure because the title block markup shifted is
      // the safe failure direction; falsely closing a live business is not.
      const titleBlock = h1?.parentElement ?? null;
      const closed = titleBlock
        ? Array.from(titleBlock.querySelectorAll('span, div')).some((el) =>
            /permanently closed|temporarily closed/i.test(el.textContent ?? ''),
          )
        : false;

      const websiteEl = document.querySelector<HTMLAnchorElement>('a[data-item-id="authority"]');
      const website = websiteEl?.href || undefined;

      const phoneEl = document.querySelector('button[data-item-id^="phone:tel:"]');
      const phone =
        phoneEl?.getAttribute('aria-label')?.replace(/^Phone:\s*/i, '').trim() ||
        phoneEl?.textContent?.trim() ||
        undefined;

      const addressEl = document.querySelector('button[data-item-id="address"]');
      const address =
        addressEl?.getAttribute('aria-label')?.replace(/^Address:\s*/i, '').trim() ||
        addressEl?.textContent?.trim() ||
        undefined;

      const category = document.querySelector('button.DkEaL')?.textContent?.trim() || undefined;

      const ratingText = document
        .querySelector('div.F7nice span[aria-hidden="true"]')
        ?.textContent?.trim();
      const rating = ratingText ? parseFloat(ratingText) : undefined;

      const reviewLabel = document
        .querySelector('div.F7nice span[aria-label*="review" i]')
        ?.getAttribute('aria-label');
      const reviewMatch = reviewLabel?.match(/[\d,]+/);
      const reviewCount = reviewMatch ? parseInt(reviewMatch[0].replace(/,/g, ''), 10) : undefined;

      if (!name) return null;
      return { name, category, address, phone, rating, reviewCount, website, closed };
    });
  } catch {
    return null;
  }
}
