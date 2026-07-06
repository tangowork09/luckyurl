import { describe, expect, it } from 'vitest';
import { ADMIN_PLAN, type Plan } from '../src/billing';
import { isWithinRetention, planHistoryDays, scanDirDate } from '../src/retention';

const DAY = 24 * 60 * 60 * 1000;

/** Build a scan-dir name (YYYY-MM-DD-HHmm-lat_lng) for a given Date. */
function dirFor(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}-12.97_77.60`;
}

function plan(over: Partial<Plan>): Plan {
  return {
    id: 'x', name: 'X', tier: 1, scansPerPeriod: 10, maxRadiusMeters: 1500, maxBusinesses: 50,
    psiAllowed: false, aiFeatures: 'none', prioritySupport: false, historyDays: 2, pricing: {}, active: true,
    ...over,
  };
}

describe('scanDirDate', () => {
  it('parses the leading timestamp of a scan dir', () => {
    const d = scanDirDate('2026-07-05-1223-12.9719_77.6412');
    expect(d).not.toBeNull();
    expect(d!.getFullYear()).toBe(2026);
    expect(d!.getMonth()).toBe(6); // July (0-based)
    expect(d!.getDate()).toBe(5);
  });
  it('returns null on an unparseable name', () => {
    expect(scanDirDate('not-a-scan-dir')).toBeNull();
    expect(scanDirDate('leads.json')).toBeNull();
  });
});

describe('planHistoryDays', () => {
  it('uses the plan field when present', () => {
    expect(planHistoryDays(plan({ historyDays: 0 }))).toBe(0);
    expect(planHistoryDays(plan({ historyDays: 2 }))).toBe(2);
    expect(planHistoryDays(plan({ historyDays: 30 }))).toBe(30);
    expect(planHistoryDays(plan({ historyDays: 3650 }))).toBe(3650);
  });
  it('falls back to a tier default for legacy plans missing the field', () => {
    const legacy = plan({ historyDays: undefined as unknown as number });
    expect(planHistoryDays({ ...legacy, tier: 0 })).toBe(0);
    expect(planHistoryDays({ ...legacy, tier: 1 })).toBe(2);
    expect(planHistoryDays({ ...legacy, tier: 2 })).toBe(30);
    expect(planHistoryDays({ ...legacy, tier: 3 })).toBe(3650);
  });
  it('gives the admin bypass plan full history', () => {
    expect(planHistoryDays(ADMIN_PLAN)).toBe(3650);
  });
});

describe('isWithinRetention', () => {
  const now = new Date('2026-07-06T12:00:00').getTime();
  const oneDayAgo = dirFor(new Date(now - 1 * DAY));
  const threeDaysAgo = dirFor(new Date(now - 3 * DAY));
  const twentyDaysAgo = dirFor(new Date(now - 20 * DAY));
  const yearsAgo = dirFor(new Date(now - 1000 * DAY));

  it('free (0 days) hides everything — the locked state', () => {
    for (const dir of [oneDayAgo, threeDaysAgo, twentyDaysAgo]) {
      expect(isWithinRetention(dir, 0, now)).toBe(false);
    }
  });

  it('starter (2 days) keeps recent scans and hides ones older than 2 days', () => {
    expect(isWithinRetention(oneDayAgo, 2, now)).toBe(true);
    expect(isWithinRetention(threeDaysAgo, 2, now)).toBe(false);
  });

  it('pro (30 days) keeps 20-day-old scans but not year-old ones', () => {
    expect(isWithinRetention(twentyDaysAgo, 30, now)).toBe(true);
    expect(isWithinRetention(yearsAgo, 30, now)).toBe(false);
  });

  it('lifetime (3650 days) shows effectively everything', () => {
    for (const dir of [oneDayAgo, threeDaysAgo, twentyDaysAgo, yearsAgo]) {
      expect(isWithinRetention(dir, 3650, now)).toBe(true);
    }
  });

  it('keeps an unparseable dir name (fail open, non-destructive)', () => {
    expect(isWithinRetention('weird-dir-name', 2, now)).toBe(true);
  });
});
