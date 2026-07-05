import { describe, expect, it } from 'vitest';
import { auditScore, classifyLead } from '../src/score';
import type { Business, WebsiteAudit, WebsiteIssue } from '../src/types';

function issue(
  id: WebsiteIssue['id'],
  severity: WebsiteIssue['severity'],
  detail = 'Test detail.',
): WebsiteIssue {
  return { id, severity, detail };
}

function biz(over: Partial<Business> = {}): Business {
  return {
    id: 'places/test-1',
    name: 'Test Cafe',
    address: '1 Main St, Bangalore',
    googleMapsUri: 'https://maps.google.com/?cid=1',
    types: ['cafe'],
    primaryType: 'cafe',
    businessStatus: 'OPERATIONAL',
    location: { lat: 12.9758, lng: 77.6045 },
    ...over,
  };
}

function makeAudit(over: Partial<WebsiteAudit> = {}): WebsiteAudit {
  return {
    url: 'https://example.com',
    reachable: true,
    https: true,
    socialOnly: false,
    issues: [],
    score: 100,
    ...over,
  };
}

describe('auditScore', () => {
  it('scores an issue-free site 100', () => {
    expect(auditScore([])).toBe(100);
  });

  it('subtracts by severity: critical 25, major 12, minor 5', () => {
    expect(auditScore([issue('no-https', 'critical')])).toBe(75);
    expect(auditScore([issue('no-meta-description', 'major')])).toBe(88);
    expect(auditScore([issue('no-favicon', 'minor')])).toBe(95);
    expect(
      auditScore([
        issue('no-https', 'critical'),
        issue('no-title', 'major'),
        issue('no-h1', 'minor'),
      ]),
    ).toBe(58);
  });

  it('clamps at 0 when penalties exceed 100', () => {
    const many = Array.from({ length: 5 }, () => issue('no-https', 'critical'));
    expect(auditScore(many)).toBe(0);
  });
});

describe('classifyLead', () => {
  it('classifies a business without a website as no-website at base 65', () => {
    const lead = classifyLead(biz());
    expect(lead?.kind).toBe('no-website');
    expect(lead?.leadScore).toBe(65);
    expect(lead?.needs.length).toBeGreaterThan(0);
    expect(lead?.pitchAngles.length).toBeGreaterThanOrEqual(2);
  });

  it('returns null for a healthy website', () => {
    const lead = classifyLead(biz(), makeAudit({ score: 85 }));
    expect(lead).toBeNull();
  });

  it('treats a social-only link as no-website and names the host', () => {
    const audit = makeAudit({
      url: 'https://www.facebook.com/testcafe',
      socialOnly: true,
      issues: [issue('social-only', 'critical')],
      score: 75,
    });
    const lead = classifyLead(biz(), audit);
    expect(lead?.kind).toBe('no-website');
    expect(lead?.needs[0]).toMatch(/facebook\.com/);
    expect(lead?.pitchAngles.join(' ')).toMatch(/facebook\.com/);
  });

  it('classifies an unreachable site as broken-website at base 75', () => {
    const audit = makeAudit({
      reachable: false,
      issues: [issue('unreachable', 'critical')],
      score: 0,
    });
    const lead = classifyLead(biz(), audit);
    expect(lead?.kind).toBe('broken-website');
    expect(lead?.leadScore).toBe(75);
  });

  it('classifies an http-error site as broken-website', () => {
    const audit = makeAudit({
      httpStatus: 500,
      issues: [issue('http-error', 'critical')],
      score: 75,
    });
    expect(classifyLead(biz(), audit)?.kind).toBe('broken-website');
  });

  it('classifies a weak live site as needs-improvement with issue-driven needs', () => {
    const audit = makeAudit({
      score: 63,
      issues: [
        issue('not-mobile-friendly', 'critical'),
        issue('no-meta-description', 'major'),
      ],
    });
    const lead = classifyLead(biz(), audit);
    expect(lead?.kind).toBe('needs-improvement');
    expect(lead?.needs).toContain('Mobile-responsive rebuild — most local customers are on phones');
    expect(lead?.needs).toContain(
      'SEO basics: titles, descriptions, social preview cards and LocalBusiness structured data',
    );
  });

  it('bumps leadScore for popular, well-rated businesses', () => {
    const audit = () =>
      makeAudit({ score: 50, issues: [issue('slow-response', 'major')] });

    const quiet = classifyLead(biz({ ratingCount: 0 }), audit());
    const popular = classifyLead(biz({ ratingCount: 400, rating: 4.6 }), audit());

    // base 30 + round((70-50)*0.5) = 40; popular adds +15 reviews +8 thriving
    expect(quiet?.leadScore).toBe(40);
    expect(popular?.leadScore).toBe(63);
    expect(popular!.leadScore).toBeGreaterThan(quiet!.leadScore);
  });

  it('adds +7 for high-value categories like dentist', () => {
    const cafe = classifyLead(biz());
    const dentist = classifyLead(biz({ primaryType: 'dentist', types: ['dentist'] }));
    expect(dentist?.leadScore).toBe(cafe!.leadScore + 7);
    expect(dentist?.leadScore).toBe(72);
  });

  it('penalises non-operational businesses by 30', () => {
    const closed = classifyLead(biz({ businessStatus: 'CLOSED_PERMANENTLY' }));
    expect(closed?.kind).toBe('no-website');
    expect(closed?.leadScore).toBe(35);
  });
});
