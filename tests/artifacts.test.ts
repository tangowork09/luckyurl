import { describe, expect, it } from 'vitest';
import { renderMockPage } from '../src/mockpage';
import { renderOnePager } from '../src/onepager';
import { buildMessages } from '../src/outreach';
import { extractEmails } from '../src/audit';
import type { Lead } from '../src/types';

function lead(over: Partial<Lead> = {}): Lead {
  return {
    kind: 'no-website',
    business: {
      id: 'x',
      name: 'Sharma <Dental> Clinic',
      address: '12 MG Road, Bengaluru',
      phone: '+91 98765 43210',
      phoneE164: '+919876543210',
      whatsappUri: 'https://wa.me/919876543210',
      email: 'hello@sharmadental.in',
      googleMapsUri: 'https://maps.google.com/x',
      rating: 4.6,
      ratingCount: 210,
      primaryType: 'dentist',
      types: ['dentist'],
      location: { lat: 12.9, lng: 77.6 },
    },
    leadScore: 82,
    scoreReasons: [{ label: 'No website at all', points: 65 }],
    needs: ['A one-page website with services and booking'],
    pitchAngles: ['They have 4.6★ from 210 reviews.'],
    estValue: { low: 15000, high: 40000, label: '₹15,000–₹40,000' },
    winnability: 'medium',
    ...over,
  };
}

describe('renderMockPage', () => {
  it('produces self-contained HTML with no external requests', () => {
    const html = renderMockPage(lead());
    expect(html).toMatch(/<!doctype html>/i);
    expect(html).not.toMatch(/https?:\/\/(?!wa\.me)/); // no external asset hosts except wa.me link
    expect(html).toContain('wa.me/919876543210');
  });

  it('escapes the business name', () => {
    expect(renderMockPage(lead())).toContain('Sharma &lt;Dental&gt; Clinic');
    expect(renderMockPage(lead())).not.toContain('<Dental>');
  });
});

describe('renderOnePager', () => {
  it('renders the audit score and needs', () => {
    const html = renderOnePager(
      lead({
        kind: 'needs-improvement',
        audit: {
          url: 'https://x.com',
          reachable: true,
          https: true,
          socialOnly: false,
          score: 41,
          issues: [{ id: 'no-https', severity: 'critical', detail: 'Served over HTTP.' }],
        },
      }),
    );
    expect(html).toContain('41');
    expect(html).toContain('Served over HTTP.');
  });
});

describe('buildMessages', () => {
  it('builds whatsapp/email/sms with deep links when contacts exist', () => {
    const m = buildMessages(lead());
    expect(m.whatsapp.length).toBeGreaterThan(20);
    expect(m.whatsappUri).toContain('wa.me/919876543210?text=');
    expect(m.mailtoUri).toContain('mailto:hello@sharmadental.in');
    expect(m.email.subject).toBeTruthy();
  });

  it('omits deep links when no contact info', () => {
    const m = buildMessages(
      lead({ business: { ...lead().business, whatsappUri: undefined, email: undefined } }),
    );
    expect(m.whatsappUri).toBeUndefined();
    expect(m.mailtoUri).toBeUndefined();
  });
});

describe('extractEmails', () => {
  it('finds real emails and drops noise', () => {
    const html = `<a href="mailto:owner@shop.in">mail</a> support@shop.in
      <img src="logo@2x.png"> noreply@wixpress.com sentry@sentry.io`;
    const emails = extractEmails(html);
    expect(emails).toContain('owner@shop.in');
    expect(emails).toContain('support@shop.in');
    expect(emails).not.toContain('noreply@wixpress.com');
    expect(emails.some((e) => e.includes('sentry'))).toBe(false);
  });
});
