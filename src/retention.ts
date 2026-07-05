/**
 * Per-plan scan-history retention.
 *
 * Scans are written to per-user directories named `YYYY-MM-DD-HHmm-lat_lng`
 * (see markdown.ts). A plan's `historyDays` decides how far back the past-scans
 * list may reach; older scan dirs are HIDDEN from the list (never deleted from
 * disk — upgrading restores visibility). historyDays===0 (free) locks history
 * entirely.
 *
 * Pure + unit-testable so the /api/leads endpoint just calls these.
 */
import type { Plan } from './billing';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Retention window in days for a plan. Uses the plan's `historyDays` when set;
 * falls back to a tier-based default for plans persisted before retention
 * existed (so an old paid deploy isn't silently locked out).
 */
export function planHistoryDays(plan: Plan): number {
  if (typeof plan.historyDays === 'number' && Number.isFinite(plan.historyDays)) {
    return Math.max(0, plan.historyDays);
  }
  if (plan.tier >= 3) return 3650;
  if (plan.tier === 2) return 30;
  if (plan.tier === 1) return 2;
  return 0;
}

/** Parse the leading `YYYY-MM-DD-HHmm` of a scan dir name to a local Date. */
export function scanDirDate(dir: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})/.exec(dir);
  if (!m) return null;
  const [, y, mo, d, hh, mm] = m;
  const dt = new Date(Number(y), Number(mo) - 1, Number(d), Number(hh), Number(mm));
  return Number.isNaN(dt.getTime()) ? null : dt;
}

/**
 * Whether a scan dir is visible under a retention window. historyDays<=0 hides
 * everything (locked). An unparseable dir name is kept (fail open — never hide
 * a scan we can't date), which stays non-destructive.
 */
export function isWithinRetention(dir: string, historyDays: number, now: number = Date.now()): boolean {
  if (historyDays <= 0) return false;
  const dt = scanDirDate(dir);
  if (!dt) return true;
  return dt.getTime() >= now - historyDays * DAY_MS;
}
