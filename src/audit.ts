/**
 * Website auditing: fetch a business website, analyse the HTML with cheap
 * regex heuristics (no DOM parser dependency) and produce a WebsiteAudit.
 *
 * analyzeHtml/isSocialUrl are pure so they can be unit-tested offline;
 * auditWebsite never rejects — every failure mode becomes an issue.
 */
import type { WebsiteAudit, WebsiteIssue } from './types';
import { auditScore } from './score';

const DEFAULT_TIMEOUT_MS = 10_000;
const PSI_TIMEOUT_MS = 60_000;
/** Read at most this much HTML; hitting the cap alone justifies heavy-page. */
const BODY_CAP_BYTES = 3_000_000;

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

/** Domains whose pages a business does not own or control. */
const SOCIAL_HOSTS = [
  'facebook.com',
  'fb.com',
  'm.facebook.com',
  'instagram.com',
  'wa.me',
  'api.whatsapp.com',
  'whatsapp.com',
  'linktr.ee',
  'linkedin.com',
  'twitter.com',
  'x.com',
  'youtube.com',
  't.me',
  'justdial.com',
  'indiamart.com',
];

export function isSocialUrl(url: string): boolean {
  let host: string;
  try {
    host = new URL(ensureProtocol(url)).hostname.toLowerCase();
  } catch {
    return false;
  }
  return SOCIAL_HOSTS.some((d) => host === d || host.endsWith(`.${d}`));
}

/* ------------------------- HTML analysis -------------------------- */

export function analyzeHtml(
  html: string,
  ctx: { finalUrl: string; https: boolean; responseMs: number; bytes: number },
): { issues: WebsiteIssue[]; tech?: string; emails: string[]; jsRendered: boolean } {
  const issues: WebsiteIssue[] = [];
  const add = (id: WebsiteIssue['id'], severity: WebsiteIssue['severity'], detail: string) =>
    issues.push({ id, severity, detail });

  const emails = extractEmails(html);
  // A JS-app shell (React/Next/Vue/Angular) has almost no server-rendered
  // content, so content-based checks (title/h1/meta/OG/schema) would wrongly
  // flag a site that clearly has those once hydrated. Detect and suppress them.
  const jsRendered = isJsShell(html);

  // --- critical ---
  if (!ctx.https) {
    add(
      'no-https',
      'critical',
      "Served over plain HTTP — browsers show a 'Not Secure' warning next to their business name.",
    );
  }
  if (findMetaContent(html, 'name', 'viewport') === undefined) {
    add(
      'not-mobile-friendly',
      'critical',
      'No viewport meta tag — the site is effectively unusable on phones, where most local searches happen.',
    );
  }
  if (ctx.https && hasMixedContent(html)) {
    add(
      'mixed-content',
      'major',
      'The secure page pulls scripts/images over plain HTTP — browsers block them and show a security warning.',
    );
  }

  // --- major (content-based; suppressed on JS shells) ---
  const title = extractTitle(html);
  if (!jsRendered && (title === undefined || title.length === 0)) {
    add(
      'no-title',
      'major',
      'The page has no <title> — Google shows a raw URL instead of their business name in results.',
    );
  } else if (title !== undefined && title.length > 0 && title.length < 15) {
    add(
      'short-title',
      'minor',
      `The page title is only ${title.length} characters — too short to say what they do or where.`,
    );
  }

  const description = findMetaContent(html, 'name', 'description');
  if (!jsRendered && (!description || description.trim().length === 0)) {
    add(
      'no-meta-description',
      'major',
      'No meta description — Google invents the search snippet, and it rarely sells.',
    );
  }

  if (jsRendered) {
    add(
      'js-rendered',
      'minor',
      'The page renders its content with JavaScript — some search engines and link previews may see a blank page.',
    );
  }

  if (ctx.responseMs > 4000) {
    add(
      'slow-response',
      'major',
      `The server took ${Math.round(ctx.responseMs)} ms to respond — most mobile visitors give up after a few seconds.`,
    );
  }

  const generator = findMetaContent(html, 'name', 'generator')?.trim();
  const tech = generator || sniffTech(html);
  const outdated = outdatedReason(generator, html);
  if (outdated) {
    add(
      'outdated-tech',
      'major',
      `Built with ${outdated} — a platform generations out of date, which signals neglect and carries known security holes.`,
    );
  }

  if (!hasContactMethod(html)) {
    add(
      'no-contact-method',
      'major',
      'No phone link, email, contact form or WhatsApp button — an interested visitor has no way to get in touch.',
    );
  }

  // --- minor ---
  // Browsers fall back to /favicon.ico, so a missing declaration stays minor.
  if (!/<link\b[^>]*rel\s*=\s*["']?[^"'>]*icon/i.test(html)) {
    add('no-favicon', 'minor', 'No favicon declared — the browser tab shows a generic blank-page icon.');
  }
  if (!jsRendered && !/<h1[\s>]/i.test(html)) {
    add('no-h1', 'minor', "No <h1> heading — search engines can't tell what the page is about.");
  }
  if (!jsRendered && !/<meta\b[^>]*property\s*=\s*["']?og:/i.test(html)) {
    add('no-og-tags', 'minor', 'No Open Graph tags — links shared on WhatsApp or Facebook show no preview card.');
  }
  if (!jsRendered && !/application\/ld\+json/i.test(html) && !/itemscope/i.test(html)) {
    add(
      'no-structured-data',
      'minor',
      "No LocalBusiness structured data — Google can't show rich results like hours or ratings.",
    );
  }
  const staleYear = staleCopyrightYear(html, new Date().getFullYear());
  if (staleYear !== undefined) {
    add('stale-copyright', 'minor', `The copyright notice says ${staleYear} — visitors read that as an abandoned business.`);
  }
  if (ctx.bytes > BODY_CAP_BYTES) {
    add('heavy-page', 'minor', `The page is ${(ctx.bytes / 1e6).toFixed(1)} MB of HTML — painfully slow on mobile data.`);
  }

  return tech ? { issues, tech, emails, jsRendered } : { issues, emails, jsRendered };
}

/** Deduped, lowercased business-looking emails; drops platform/noise addresses. */
export function extractEmails(html: string): string[] {
  const NOISE = /(sentry|wixpress|no-?reply|noreply|example\.com|@2x|\.png|\.jpg|\.svg|\.gif|domain\.com|email\.com|yourdomain|sentry\.io)/i;
  const found = new Set<string>();
  const re = /[a-z0-9][a-z0-9._%+-]*@[a-z0-9.-]+\.[a-z]{2,}/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const email = m[0].toLowerCase();
    if (!NOISE.test(email) && email.length <= 60) found.add(email);
    if (found.size >= 3) break;
  }
  return [...found];
}

/** True when the HTML looks like an unrendered single-page-app shell. */
function isJsShell(html: string): boolean {
  const markers =
    /__NEXT_DATA__|data-reactroot|id=["']root["']|id=["']__next["']|ng-version|data-server-rendered|wix-warmup-data|__NUXT__/i;
  if (!markers.test(html)) return false;
  // Sparse rendered text alongside a framework marker => shell, not content.
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length < 600;
}

/** Active mixed content: an HTTPS page loading scripts/styles/media over HTTP. */
function hasMixedContent(html: string): boolean {
  // src-loading tags always fetch their target.
  if (/<(?:script|img|iframe|source|video|audio)\b[^>]*\bsrc\s*=\s*["']http:\/\//i.test(html)) {
    return true;
  }
  // <link> only fetches for resource rels — canonical/alternate/preconnect/
  // dns-prefetch are metadata and must not count as mixed content.
  for (const tag of html.match(/<link\b[^>]*>/gi) ?? []) {
    if (!/\bhref\s*=\s*["']http:\/\//i.test(tag)) continue;
    if (/\brel\s*=\s*["']?[^"'>]*(?:stylesheet|icon|preload|prefetch|manifest)/i.test(tag)) {
      return true;
    }
  }
  return false;
}

function extractTitle(html: string): string | undefined {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  return m ? m[1].trim() : undefined;
}

/** Find a <meta attr="value" content="..."> tag regardless of attribute order. */
function findMetaContent(html: string, attr: 'name' | 'property', value: string): string | undefined {
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    const attrRe = new RegExp(`${attr}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i');
    const m = attrRe.exec(tag);
    const got = m ? (m[2] ?? m[3] ?? m[4] ?? '') : '';
    if (got.trim().toLowerCase() !== value) continue;
    const c = /content\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/i.exec(tag);
    return c ? (c[2] ?? c[3] ?? c[4] ?? '') : '';
  }
  return undefined;
}

function sniffTech(html: string): string | undefined {
  if (/wp-content/i.test(html)) return 'WordPress';
  if (/wixstatic|wix\.com/i.test(html)) return 'Wix';
  if (/squarespace/i.test(html)) return 'Squarespace';
  if (/wsimg\.com/i.test(html)) return 'GoDaddy';
  if (/blogspot/i.test(html)) return 'Blogger';
  if (/cdn\.shopify\.com/i.test(html)) return 'Shopify';
  return undefined;
}

/**
 * Outdated only when the generator reveals an old major (WordPress < 6,
 * Joomla 1/2/3, FrontPage/Dreamweaver/Blogger) or the site is on Blogspot.
 * A sniffed CMS without a version is informational, not an issue.
 */
function outdatedReason(generator: string | undefined, html: string): string | undefined {
  if (generator) {
    const wp = /wordpress[^\d]*(\d+)/i.exec(generator);
    if (wp && Number(wp[1]) < 6) return generator;
    if (/joomla!?[^\d]*([123])(?!\d)/i.test(generator)) return generator;
    if (/frontpage|dreamweaver|blogger/i.test(generator)) return generator;
  }
  if (/blogspot/i.test(html)) return 'Blogger (Blogspot)';
  return undefined;
}

function hasContactMethod(html: string): boolean {
  return (
    /href\s*=\s*["']?tel:/i.test(html) ||
    /mailto:/i.test(html) ||
    /<form\b/i.test(html) ||
    /href\s*=\s*["'][^"']*contact[^"']*["']/i.test(html) ||
    /whatsapp|wa\.me/i.test(html)
  );
}

/**
 * A year 2000..currentYear-3 adjacent to a copyright mark, with no year
 * >= currentYear-1 similarly adjacent, reads as an abandoned site.
 */
function staleCopyrightYear(html: string, currentYear: number): number | undefined {
  const years: number[] = [];
  const re =
    /(?:©|&copy;|\(c\)|copyright)[^\d<>]{0,30}(\d{4})|(\d{4})[^\d<>]{0,30}(?:©|&copy;|\(c\)|copyright)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const y = Number(m[1] ?? m[2]);
    if (y >= 1990 && y <= currentYear + 1) years.push(y);
  }
  if (years.some((y) => y >= currentYear - 1)) return undefined;
  const stale = years.filter((y) => y >= 2000 && y <= currentYear - 3);
  return stale.length > 0 ? Math.max(...stale) : undefined;
}

/* --------------------------- fetching ----------------------------- */

export interface AuditOpts {
  pagespeedKey?: string;
  timeoutMs?: number;
  psi?: boolean;
  /** HEAD-sample internal links/forms to flag broken-link/dead-form (slower). */
  checkLinks?: boolean;
}

export async function auditWebsite(
  url: string,
  opts?: AuditOpts,
): Promise<WebsiteAudit> {
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const normalized = ensureProtocol(url.trim());

  if (isSocialUrl(normalized)) {
    // Never fetch social/aggregator pages — the link itself is the finding.
    const issues: WebsiteIssue[] = [
      {
        id: 'social-only',
        severity: 'critical',
        detail: "Their only web presence is a social/aggregator page they don't own or control.",
      },
    ];
    return {
      url: normalized,
      reachable: true,
      https: normalized.startsWith('https'),
      socialOnly: true,
      issues,
      score: auditScore(issues),
    };
  }

  try {
    return await fetchAndAnalyze(normalized, timeoutMs, opts);
  } catch (err) {
    const issues: WebsiteIssue[] = [
      {
        id: 'unreachable',
        severity: 'critical',
        detail: `Could not reach the website: ${errorMessage(err, timeoutMs)}.`,
      },
    ];
    return {
      url: normalized,
      reachable: false,
      https: normalized.startsWith('https'),
      socialOnly: false,
      issues,
      score: 0,
    };
  }
}

async function fetchAndAnalyze(
  url: string,
  timeoutMs: number,
  opts?: AuditOpts,
): Promise<WebsiteAudit> {
  let fetched: { res: Response; responseMs: number };
  try {
    fetched = await fetchOnce(url, timeoutMs);
  } catch (err) {
    // Some old sites are http-only: retry the https default once over http.
    if (!url.startsWith('https://')) throw err;
    const httpUrl = `http://${url.slice('https://'.length)}`;
    fetched = await fetchOnce(httpUrl, timeoutMs);
  }

  const { res, responseMs } = fetched;
  const finalUrl = res.url || url;
  const https = finalUrl.startsWith('https');

  if (!res.ok) {
    res.body?.cancel().catch(() => {});
    const issues: WebsiteIssue[] = [
      { id: 'http-error', severity: 'critical', detail: `Website returns HTTP ${res.status}.` },
    ];
    return {
      url,
      finalUrl,
      reachable: true,
      httpStatus: res.status,
      https,
      responseMs,
      socialOnly: false,
      issues,
      score: auditScore(issues),
    };
  }

  const { text, bytes, capped } = await readBodyCapped(res, BODY_CAP_BYTES);
  const { issues, tech, emails, jsRendered } = analyzeHtml(text, { finalUrl, https, responseMs, bytes });
  if (capped && !issues.some((i) => i.id === 'heavy-page')) {
    issues.push({
      id: 'heavy-page',
      severity: 'minor',
      detail: `The page exceeds ${BODY_CAP_BYTES / 1e6} MB of HTML — painfully slow on mobile data.`,
    });
  }

  // Security headers: an HTTPS site missing both HSTS and content-type sniffing
  // protection is a mild, credible tell that the build is neglected.
  if (https && !res.headers.get('strict-transport-security') && !res.headers.get('x-content-type-options')) {
    issues.push({
      id: 'insecure-headers',
      severity: 'minor',
      detail: 'Missing basic security headers (HSTS, X-Content-Type-Options) — a sign of an unmaintained setup.',
    });
  }

  if (opts?.checkLinks) {
    issues.push(...(await checkLinksAndForms(text, finalUrl, timeoutMs)));
  }

  let psi = opts?.psi ? await runPsi(finalUrl, opts.pagespeedKey) : undefined;
  if (psi) issues.push(...psiIssues(psi));

  const audit: WebsiteAudit = {
    url,
    finalUrl,
    reachable: true,
    httpStatus: res.status,
    https,
    responseMs,
    htmlBytes: bytes,
    socialOnly: false,
    issues,
    score: auditScore(issues, psi),
  };
  if (tech) audit.tech = tech;
  if (jsRendered) audit.jsRendered = true;
  if (emails.length > 0) audit.emails = emails;
  if (psi) {
    // The base64 screenshot is written to disk by the caller, never left in the
    // audit that gets JSON-serialised into leads.json (it would bloat it hugely).
    const { screenshotBase64, ...psiRest } = psi;
    audit.psi = psiRest;
    if (screenshotBase64) audit.psi.screenshotBase64 = screenshotBase64;
  }
  return audit;
}

/** Turn a PSI result into audit issues (called once, keeps fetchAndAnalyze tidy). */
function psiIssues(psi: NonNullable<WebsiteAudit['psi']>): WebsiteIssue[] {
  const out: WebsiteIssue[] = [];
  if (psi.performance !== undefined && psi.performance < 50) {
    out.push({
      id: 'poor-psi-performance',
      severity: 'major',
      detail: `Google PageSpeed mobile performance score is ${psi.performance}/100 — the site feels sluggish on phones.`,
    });
  }
  if (psi.seo !== undefined && psi.seo < 70) {
    out.push({
      id: 'poor-psi-seo',
      severity: 'major',
      detail: `Google PageSpeed SEO score is ${psi.seo}/100 — basic search optimisation is missing.`,
    });
  }
  if (psi.accessibility !== undefined && psi.accessibility < 70) {
    out.push({
      id: 'poor-accessibility',
      severity: 'minor',
      detail: `Accessibility score is ${psi.accessibility}/100 — parts of the site are unusable for some visitors.`,
    });
  }
  if (psi.lcpMs !== undefined && psi.lcpMs > 2500) {
    out.push({
      id: 'poor-cwv-lcp',
      severity: 'major',
      detail: `Largest content takes ${(psi.lcpMs / 1000).toFixed(1)}s to appear on mobile — Google's target is under 2.5s.`,
    });
  }
  if (psi.cls !== undefined && psi.cls > 0.1) {
    out.push({
      id: 'poor-cwv-cls',
      severity: 'minor',
      detail: `The layout shifts while loading (CLS ${psi.cls.toFixed(2)}) — content jumps under the visitor's finger.`,
    });
  }
  return out;
}

/**
 * HEAD-sample same-origin links + form actions; flag broken-link / dead-form.
 * Best-effort and bounded (few requests, short timeout); skips cross-origin.
 */
async function checkLinksAndForms(
  html: string,
  finalUrl: string,
  timeoutMs: number,
): Promise<WebsiteIssue[]> {
  let origin: string;
  try {
    origin = new URL(finalUrl).origin;
  } catch {
    return [];
  }
  const resolve = (href: string): string | undefined => {
    try {
      const u = new URL(href, finalUrl);
      return u.origin === origin ? u.href : undefined; // same-origin only
    } catch {
      return undefined;
    }
  };

  const links = new Set<string>();
  for (const m of html.matchAll(/<a\b[^>]*\bhref\s*=\s*["']([^"'#]+)["']/gi)) {
    const u = resolve(m[1]);
    if (u && !/^(mailto:|tel:|javascript:)/i.test(m[1])) links.add(u);
    if (links.size >= 6) break;
  }
  const forms = new Set<string>();
  for (const m of html.matchAll(/<form\b[^>]*\baction\s*=\s*["']([^"']+)["']/gi)) {
    const u = resolve(m[1]);
    if (u) forms.add(u);
    if (forms.size >= 2) break;
  }

  const probe = async (u: string): Promise<boolean> => {
    try {
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), Math.min(timeoutMs, 8000));
      try {
        let res = await fetch(u, { method: 'HEAD', redirect: 'follow', signal: ac.signal, headers: { 'User-Agent': USER_AGENT } });
        // Some servers reject HEAD (405) — retry GET before calling it broken.
        if (res.status === 405) res = await fetch(u, { method: 'GET', redirect: 'follow', signal: ac.signal, headers: { 'User-Agent': USER_AGENT } });
        return res.status >= 400;
      } finally {
        clearTimeout(t);
      }
    } catch (err) {
      // Our own timeout/abort proves slowness, not brokenness — a false
      // "your link is broken" claim would sink the pitch's credibility.
      if (err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')) {
        return false;
      }
      return true; // genuine network failure counts as broken
    }
  };

  const issues: WebsiteIssue[] = [];
  const brokenLinks = (await Promise.all([...links].map(async (u) => ((await probe(u)) ? u : null)))).filter(
    (u): u is string => u !== null,
  );
  if (brokenLinks.length > 0) {
    issues.push({
      id: 'broken-link',
      severity: 'major',
      detail: `${brokenLinks.length} internal link${brokenLinks.length > 1 ? 's' : ''} on the site 404 or fail to load — visitors hit dead ends.`,
    });
  }
  const deadForms = (await Promise.all([...forms].map(async (u) => ((await probe(u)) ? u : null)))).filter(
    (u): u is string => u !== null,
  );
  if (deadForms.length > 0) {
    issues.push({
      id: 'dead-form',
      severity: 'major',
      detail: 'The contact/enquiry form submits to a URL that errors — enquiries are silently lost.',
    });
  }
  return issues;
}

async function fetchOnce(url: string, timeoutMs: number): Promise<{ res: Response; responseMs: number }> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  const started = Date.now();
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: ac.signal,
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
      },
    });
    return { res, responseMs: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
}

async function readBodyCapped(
  res: Response,
  cap: number,
): Promise<{ text: string; bytes: number; capped: boolean }> {
  const body = res.body;
  if (!body) {
    const text = await res.text();
    const bytes = Buffer.byteLength(text);
    return { text: text.slice(0, cap), bytes: Math.min(bytes, cap), capped: bytes > cap };
  }

  const reader = body.getReader();
  const chunks: Buffer[] = [];
  let received = 0;
  let capped = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    const chunk = Buffer.from(value);
    received += chunk.byteLength;
    chunks.push(chunk);
    if (received >= cap) {
      capped = true;
      await reader.cancel().catch(() => {});
      break;
    }
  }
  const text = Buffer.concat(chunks).subarray(0, cap).toString('utf8');
  return { text, bytes: Math.min(received, cap), capped };
}

/**
 * PSI is best-effort: any failure leaves the audit valid without psi data. One
 * v5 call already returns performance/SEO/accessibility/best-practices, lab
 * Core Web Vitals, and a mobile screenshot — we ask for all of it (same cost).
 */
async function runPsi(pageUrl: string, key?: string): Promise<WebsiteAudit['psi']> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), PSI_TIMEOUT_MS);
  try {
    const cats = ['PERFORMANCE', 'SEO', 'ACCESSIBILITY', 'BEST_PRACTICES']
      .map((c) => `&category=${c}`)
      .join('');
    const endpoint =
      'https://www.googleapis.com/pagespeedonline/v5/runPagespeed' +
      `?url=${encodeURIComponent(pageUrl)}&strategy=MOBILE${cats}` +
      (key ? `&key=${encodeURIComponent(key)}` : '');
    const res = await fetch(endpoint, { signal: ac.signal });
    if (!res.ok) return undefined;
    const data = (await res.json()) as {
      lighthouseResult?: {
        categories?: Record<string, { score?: unknown }>;
        audits?: Record<
          string,
          { numericValue?: unknown; details?: { data?: unknown; items?: { data?: unknown }[] } }
        >;
      };
    };
    const lh = data.lighthouseResult;
    const cat = lh?.categories;
    const audits = lh?.audits;
    const toScore = (v: unknown) => (typeof v === 'number' ? Math.round(v * 100) : undefined);
    const numeric = (id: string) => {
      const v = audits?.[id]?.numericValue;
      return typeof v === 'number' ? v : undefined;
    };

    const psi: NonNullable<WebsiteAudit['psi']> = {
      performance: toScore(cat?.performance?.score),
      seo: toScore(cat?.seo?.score),
      accessibility: toScore(cat?.accessibility?.score),
      bestPractices: toScore(cat?.['best-practices']?.score),
      lcpMs: numeric('largest-contentful-paint'),
      cls: numeric('cumulative-layout-shift'),
      inpMs: numeric('interactive'),
    };
    // final-screenshot uses the "screenshot" detail type: base64 lives at
    // details.data (not details.items). Keep items as a fallback shape.
    const shotDetails = audits?.['final-screenshot']?.details;
    const shot = shotDetails?.data ?? shotDetails?.items?.[0]?.data;
    if (typeof shot === 'string' && shot.startsWith('data:image')) {
      psi.screenshotBase64 = shot;
    }

    if (Object.values(psi).every((v) => v === undefined)) return undefined;
    return psi;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

/* --------------------------- helpers ------------------------------ */

function ensureProtocol(url: string): string {
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(url) ? url : `https://${url}`;
}

function errorMessage(err: unknown, timeoutMs: number): string {
  if (err instanceof Error) {
    if (err.name === 'AbortError' || err.name === 'TimeoutError') {
      return `timed out after ${timeoutMs} ms`;
    }
    // Node's fetch wraps the real network error (ENOTFOUND, cert...) in cause.
    const cause = (err as { cause?: unknown }).cause;
    if (cause instanceof Error && cause.message) return cause.message;
    return err.message;
  }
  return String(err);
}
