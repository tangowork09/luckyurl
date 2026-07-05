/**
 * Lead scoring & classification.
 *
 * Pure and deterministic: no clock, no I/O. Time-dependent checks
 * (stale-copyright) live in audit.ts; this module only interprets the
 * issues it is handed. Scoring knobs come from a ScoringWeights object so the
 * ranking can be re-tuned (or an existing leads.json re-ranked) without code
 * changes; DEFAULT_WEIGHTS preserves the original behaviour.
 */
import {
  BASE_PROJECT_VALUE_INR,
  CATEGORY_GROUPS,
  CATEGORY_VALUE,
  HIGH_VALUE_TYPES,
  isNationalChain,
} from './categories';
import type {
  Business,
  CategoryContext,
  Lead,
  LeadKind,
  ScoreReason,
  ScoringWeights,
  ValueEstimate,
  WebsiteAudit,
  WebsiteIssue,
  WebsiteIssueId,
  Winnability,
} from './types';

export const DEFAULT_WEIGHTS: ScoringWeights = {
  severity: { critical: 25, major: 12, minor: 5 },
  base: { 'broken-website': 75, 'no-website': 65, 'needs-improvement': 30 },
  healthyThreshold: 70,
  popularityCap: 15,
  reviewsPerPoint: 20,
  thrivingBonus: 8,
  notOperationalPenalty: 30,
  categoryValueBonus: 7,
  competitorDensityBonus: 1.5,
  competitorDensityCap: 12,
  chainPenalty: 25,
};

const SEVERITY_RANK: Record<WebsiteIssue['severity'], number> = {
  critical: 3,
  major: 2,
  minor: 1,
};

export function auditScore(
  issues: WebsiteIssue[],
  _psi?: WebsiteAudit['psi'],
  weights: ScoringWeights = DEFAULT_WEIGHTS,
): number {
  const penalty = issues.reduce((sum, i) => sum + weights.severity[i.severity], 0);
  return clamp(100 - penalty, 0, 100);
}

export function classifyLead(
  b: Business,
  audit?: WebsiteAudit,
  weights: ScoringWeights = DEFAULT_WEIGHTS,
): Lead | null {
  const kind = determineKind(audit, weights);
  if (!kind) return null;

  const { total, reasons } = computeLeadScore(kind, b, audit, weights);
  const catValue = categoryValue(b);

  const lead: Lead = {
    kind,
    business: b,
    leadScore: total,
    scoreReasons: reasons,
    needs: buildNeeds(kind, b, audit),
    pitchAngles: buildPitchAngles(kind, b, audit),
    estValue: estimateBudget(kind, catValue),
    winnability: winnabilityOf(kind, b),
  };
  if (audit) lead.audit = audit;
  return lead;
}

/**
 * Recompute a lead's score with same-category competitive context folded in.
 * Pure: returns a new Lead. Called by the cross-lead pass in scan.ts once all
 * businesses are classified. Bonus scales with how many rivals already run a
 * healthy site ("you're being out-ranked"); clamped for the sparse OSM path.
 */
export function withCompetitorContext(
  lead: Lead,
  context: CategoryContext,
  weights: ScoringWeights = DEFAULT_WEIGHTS,
): Lead {
  const bonus = Math.min(
    weights.competitorDensityCap,
    Math.round(context.withHealthySite * weights.competitorDensityBonus),
  );
  const reasons = [...lead.scoreReasons];
  const pitchAngles = [...lead.pitchAngles];
  if (bonus > 0) {
    reasons.push({
      label: `${context.withHealthySite} nearby ${'rivals'} already have a real site`,
      points: bonus,
    });
    pitchAngles.unshift(
      `${context.withHealthySite} of ${context.total} nearby businesses in their category already ` +
        `run a proper website — every one is a competitor capturing customers they can't.`,
    );
  }
  const { total: leadScore, reasons: finalReasons } = finalizeScore(reasons);
  return { ...lead, context, leadScore, scoreReasons: finalReasons, pitchAngles: pitchAngles.slice(0, 4) };
}

/* ------------------------------------------------------------------ */

function determineKind(
  audit: WebsiteAudit | undefined,
  weights: ScoringWeights,
): LeadKind | null {
  if (!audit) return 'no-website';
  // A Facebook/Instagram/aggregator page is not a website they own.
  if (audit.socialOnly) return 'no-website';
  if (!audit.reachable || hasIssue(audit, 'http-error')) return 'broken-website';
  if (audit.score < weights.healthyThreshold || audit.issues.some((i) => i.severity === 'critical')) {
    return 'needs-improvement';
  }
  return null; // healthy site — not a lead
}

function computeLeadScore(
  kind: LeadKind,
  b: Business,
  audit: WebsiteAudit | undefined,
  weights: ScoringWeights,
): { total: number; reasons: ScoreReason[] } {
  const reasons: ScoreReason[] = [];

  if (kind === 'broken-website') {
    reasons.push({ label: 'Website is down / broken', points: weights.base['broken-website'] });
  } else if (kind === 'no-website') {
    reasons.push({ label: 'No website at all', points: weights.base['no-website'] });
  } else {
    const base = weights.base['needs-improvement'];
    const severityBump = Math.round((weights.healthyThreshold - (audit?.score ?? weights.healthyThreshold)) * 0.5);
    reasons.push({ label: 'Website needs improvement', points: base });
    if (severityBump > 0) reasons.push({ label: `Audit score only ${audit?.score}/100`, points: severityBump });
  }

  const ratingCount = b.ratingCount ?? 0;
  // Rating drives popularity when present; else fall back to OSM maturity proxy.
  if (ratingCount > 0) {
    const pop = Math.min(weights.popularityCap, Math.floor(ratingCount / weights.reviewsPerPoint));
    if (pop > 0) reasons.push({ label: `${ratingCount} Google reviews`, points: pop });
    if ((b.rating ?? 0) >= 4.3 && ratingCount >= 20) {
      reasons.push({ label: `Thriving (${b.rating}★)`, points: weights.thrivingBonus });
    }
  } else if (b.maturity !== undefined) {
    const pop = Math.round((b.maturity / 100) * weights.popularityCap);
    if (pop > 0) reasons.push({ label: 'Well-established listing', points: pop });
  }

  const catValue = categoryValue(b);
  // Bonus-only: reward high-value categories, never penalise ordinary ones.
  const catBonus = Math.max(0, Math.round((catValue - 1) * weights.categoryValueBonus));
  if (catBonus > 0) {
    reasons.push({ label: 'High-value category', points: catBonus });
  }

  if (isNationalChain(b.name)) {
    reasons.push({ label: 'National chain / franchise', points: -weights.chainPenalty });
  }
  if (b.businessStatus && b.businessStatus !== 'OPERATIONAL') {
    reasons.push({ label: 'Not currently operational', points: -weights.notOperationalPenalty });
  }

  return finalizeScore(reasons);
}

/** Clamp the reason sum to 5..99 and record the clamp delta so rows still add up. */
function finalizeScore(reasons: ScoreReason[]): { total: number; reasons: ScoreReason[] } {
  const raw = sumReasons(reasons);
  const total = clamp(raw, 5, 99);
  if (total !== raw) {
    reasons.push({ label: total > raw ? 'Minimum lead floor' : 'Capped at 99', points: total - raw });
  }
  return { total, reasons };
}

function sumReasons(reasons: ScoreReason[]): number {
  return reasons.reduce((s, r) => s + r.points, 0);
}

/* ---------------------------- value ------------------------------- */

function categoryValue(b: Business): number {
  const types = b.primaryType ? [b.primaryType, ...b.types] : b.types;
  let max = -Infinity;
  let min = Infinity;
  for (const t of types) {
    const v = CATEGORY_VALUE[t];
    if (v === undefined) continue;
    if (v > max) max = v;
    if (v < min) min = v;
  }
  // Any above-baseline facet wins (a restaurant that also does takeaway is a
  // restaurant); a uniformly low-value business keeps its discount.
  if (max > 1) return max;
  if (min < 1) return min;
  return 1;
}

function estimateBudget(kind: LeadKind, catValue: number): ValueEstimate {
  const kindMult = kind === 'broken-website' ? 1.2 : kind === 'no-website' ? 1.0 : 0.7;
  const mid = BASE_PROJECT_VALUE_INR * catValue * kindMult;
  const low = Math.round((mid * 0.75) / 1000) * 1000;
  const high = Math.round((mid * 2) / 1000) * 1000;
  return { low, high, label: `${formatInr(low)}–${formatInr(high)}` };
}

/** Indian grouping: ₹1,20,000 (lakh style). */
function formatInr(n: number): string {
  const s = String(Math.round(n));
  if (s.length <= 3) return `₹${s}`;
  const last3 = s.slice(-3);
  const rest = s.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',');
  return `₹${rest},${last3}`;
}

function winnabilityOf(kind: LeadKind, b: Business): Winnability {
  const reviews = b.ratingCount ?? 0;
  const rating = b.rating ?? 0;
  if (isNationalChain(b.name)) return 'hard';
  if (reviews >= 200) return 'hard'; // big, likely has an agency already
  if (kind === 'needs-improvement' && rating >= 4.3 && reviews >= 50) return 'hard';
  if (kind === 'no-website' && reviews < 100) return 'easy';
  if (kind === 'broken-website') return 'easy';
  return 'medium';
}

/* ---------------------------- needs ------------------------------- */

const WHATSAPP_NEED = 'WhatsApp click-to-chat button so customers reach them in one tap';
const GBP_NEED = 'Google Business Profile linked to a real domain they own';

function buildNeeds(kind: LeadKind, b: Business, audit?: WebsiteAudit): string[] {
  const out: string[] = [];

  if (kind === 'no-website') {
    if (audit?.socialOnly) {
      out.push(
        `A real website they own — right now customers land on ${hostOf(audit.url)} instead`,
      );
    }
    out.push(firstSiteNeed(b), WHATSAPP_NEED, GBP_NEED, localSeoNeed(b));
  } else if (kind === 'broken-website') {
    out.push(
      'Urgent fix or rebuild — their website is down and the Google listing links to it',
      WHATSAPP_NEED,
      localSeoNeed(b),
    );
  } else {
    out.push(...improvementNeeds(audit));
  }

  return dedupe(out).slice(0, 5);
}

/** First deliverable of a from-scratch site, worded for the business category. */
function firstSiteNeed(b: Business): string {
  switch (categoryGroupKey(b)) {
    case 'food':
      return 'One-page website with their menu, photos and opening hours';
    case 'health':
    case 'professional':
      return 'One-page website with their services, photos, opening hours and appointment booking';
    case 'retail':
      return 'One-page website with their product catalogue, photos and opening hours';
    case 'beauty':
    case 'fitness':
      return 'One-page website with their price list, photos and online booking';
    default:
      return 'One-page website with their menu/services, photos and opening hours';
  }
}

function localSeoNeed(b: Business): string {
  return `Basic local SEO so they appear for '${primaryCategoryLabel(b)} near me' searches`;
}

const SEO_BASIC_IDS: WebsiteIssueId[] = [
  'no-meta-description',
  'no-title',
  'no-structured-data',
  'no-og-tags',
  'poor-psi-seo',
];
const PERFORMANCE_IDS: WebsiteIssueId[] = [
  'slow-response',
  'heavy-page',
  'poor-psi-performance',
  'poor-cwv-lcp',
  'poor-cwv-cls',
];

function improvementNeeds(audit?: WebsiteAudit): string[] {
  const issues = audit?.issues ?? [];
  const ids = new Set(issues.map((i) => i.id));
  const out: string[] = [];

  if (ids.has('not-mobile-friendly')) {
    out.push('Mobile-responsive rebuild — most local customers are on phones');
  }
  if (ids.has('no-https') || ids.has('mixed-content') || ids.has('insecure-headers')) {
    out.push('HTTPS/SSL + security fixes — browsers currently flag the site as Not Secure');
  }
  if (ids.has('broken-link') || ids.has('dead-form')) {
    out.push('Fix broken links and the contact form — enquiries are currently going nowhere');
  }
  if (SEO_BASIC_IDS.some((id) => ids.has(id))) {
    out.push('SEO basics: titles, descriptions, social preview cards and LocalBusiness structured data');
  }
  if (ids.has('poor-accessibility')) {
    out.push('Accessibility fixes so the site works for every visitor (and ranks better)');
  }
  const abandoned = issues.find(
    (i) => i.id === 'stale-copyright' || i.id === 'outdated-tech' || i.id === 'stale-content',
  );
  if (abandoned) {
    out.push(`Modern rebuild — the site looks abandoned (${detailHint(abandoned)})`);
  }
  if (PERFORMANCE_IDS.some((id) => ids.has(id))) {
    out.push('Performance overhaul — the site takes too long to load');
  }
  if (ids.has('no-contact-method')) {
    out.push('Clear contact path: tap-to-call, WhatsApp and a short enquiry form');
  }
  if (out.length === 0) {
    out.push('Website tune-up fixing the smaller issues flagged in the audit');
  }
  return out;
}

/** Compress an issue detail sentence into a short parenthetical hint. */
function detailHint(issue: WebsiteIssue): string {
  const head = issue.detail.split(' — ')[0].replace(/\.\s*$/, '');
  return head.charAt(0).toLowerCase() + head.slice(1);
}

/* ------------------------- pitch angles --------------------------- */

function buildPitchAngles(kind: LeadKind, b: Business, audit?: WebsiteAudit): string[] {
  const out: string[] = [];
  const rating = b.rating ?? 0;
  const ratingCount = b.ratingCount ?? 0;

  if (ratingCount >= 20 && rating >= 4) {
    out.push(
      `They have ${rating}★ from ${ratingCount} reviews — a strong reputation that currently converts to nothing online.`,
    );
  }
  if (audit?.socialOnly) {
    out.push(
      `Their entire web presence is a ${hostOf(audit.url)} page they don't own or control — it can't rank on Google and could vanish overnight.`,
    );
  }

  if (kind === 'no-website') {
    out.push('Every competitor result on Google Maps with a website is capturing customers they earned.');
  } else if (kind === 'broken-website') {
    out.push('Their Google listing sends people to a dead link — every click is a lost customer and a trust hit.');
  } else {
    out.push(worstIssuesAngle(audit));
  }

  if (isHighValue(b)) {
    out.push('High-ticket category — a single new client pays for the site many times over.');
  }
  if (out.length < 2) {
    out.push('A focused one-week build would turn the attention their Google listing already gets into actual enquiries.');
  }
  return out.slice(0, 4);
}

function worstIssuesAngle(audit?: WebsiteAudit): string {
  const worst = [...(audit?.issues ?? [])]
    .sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity])
    .slice(0, 2);
  if (worst.length === 0) {
    return `Their website scores ${audit?.score ?? 0}/100 on our audit — well below what customers expect today.`;
  }
  return `Their own site is working against them: ${worst.map((i) => i.detail).join(' ')}`;
}

/* --------------------------- helpers ------------------------------ */

function isHighValue(b: Business): boolean {
  const types = b.primaryType ? [b.primaryType, ...b.types] : b.types;
  return types.some((t) => HIGH_VALUE_TYPES.has(t));
}

function categoryGroupKey(b: Business): string | undefined {
  const primary = b.primaryType;
  if (primary) {
    const byPrimary = CATEGORY_GROUPS.find((g) => g.types.includes(primary));
    if (byPrimary) return byPrimary.key;
  }
  return CATEGORY_GROUPS.find((g) => b.types.some((t) => g.types.includes(t)))?.key;
}

/** Category group key for a business, used by the competitor-density pass. */
export function groupKeyOf(b: Business): string {
  return categoryGroupKey(b) ?? b.primaryType ?? b.types[0] ?? 'other';
}

function primaryCategoryLabel(b: Business): string {
  return (b.primaryType ?? b.types[0] ?? 'business').replace(/_/g, ' ');
}

function hostOf(url: string): string {
  try {
    const withProto = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(url) ? url : `https://${url}`;
    return new URL(withProto).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

function hasIssue(audit: WebsiteAudit, id: WebsiteIssueId): boolean {
  return audit.issues.some((i) => i.id === id);
}

function dedupe(items: string[]): string[] {
  return Array.from(new Set(items));
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}
