import { describe, expect, it } from 'vitest';
import { analyzeHtml, isSocialUrl } from '../src/audit';
import type { WebsiteIssueId } from '../src/types';

function ctx(over: Partial<{ finalUrl: string; https: boolean; responseMs: number; bytes: number }> = {}) {
  return { finalUrl: 'https://example.com/', https: true, responseMs: 400, bytes: 25_000, ...over };
}

function ids(result: { issues: { id: WebsiteIssueId }[] }): WebsiteIssueId[] {
  return result.issues.map((i) => i.id);
}

describe('isSocialUrl', () => {
  it('matches social/aggregator hosts', () => {
    expect(isSocialUrl('https://facebook.com/somecafe')).toBe(true);
    expect(isSocialUrl('https://wa.me/919876543210')).toBe(true);
    expect(isSocialUrl('https://linktr.ee/somecafe')).toBe(true);
    expect(isSocialUrl('https://www.justdial.com/Bangalore/some-cafe')).toBe(true);
  });

  it('matches subdomains of social hosts', () => {
    expect(isSocialUrl('https://www.facebook.com/somecafe')).toBe(true);
    expect(isSocialUrl('http://m.facebook.com/somecafe')).toBe(true);
    expect(isSocialUrl('https://in.linkedin.com/company/some-co')).toBe(true);
  });

  it('tolerates a missing protocol', () => {
    expect(isSocialUrl('instagram.com/somecafe')).toBe(true);
    expect(isSocialUrl('www.youtube.com/@somecafe')).toBe(true);
  });

  it('rejects ordinary business domains', () => {
    expect(isSocialUrl('https://example.com')).toBe(false);
    expect(isSocialUrl('sharmadental.in')).toBe(false);
    // lookalike suffix must not match the endsWith('.<domain>') rule
    expect(isSocialUrl('https://facebook.com.attacker.example')).toBe(false);
    expect(isSocialUrl('https://myfacebook.company')).toBe(false);
  });

  it('returns false on unparseable input', () => {
    expect(isSocialUrl('not a url at all')).toBe(false);
    expect(isSocialUrl('')).toBe(false);
  });
});

describe('analyzeHtml', () => {
  it('finds no critical or major issues on a healthy page', () => {
    const year = new Date().getFullYear();
    const html = `<!doctype html><html><head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <title>Sharma Dental Clinic — Koramangala, Bangalore</title>
      <meta name="description" content="Family dental clinic in Koramangala offering implants, braces and cleanings.">
      <meta property="og:title" content="Sharma Dental Clinic">
      <link rel="icon" href="/favicon.ico">
      <script type="application/ld+json">{"@type":"Dentist","name":"Sharma Dental Clinic"}</script>
      </head><body>
      <h1>Sharma Dental Clinic</h1>
      <a href="tel:+919876543210">Call us</a>
      <form action="/contact"><input name="q"></form>
      <footer>© ${year} Sharma Dental Clinic</footer>
      </body></html>`;

    const result = analyzeHtml(html, ctx());
    const severe = result.issues.filter((i) => i.severity === 'critical' || i.severity === 'major');
    expect(severe).toEqual([]);
    expect(result.issues).toEqual([]); // nothing minor to flag either
  });

  it('flags an empty-ish 90s page', () => {
    const html = `<html><head><title>Welcome to the homepage of our shop</title></head>
      <body><center><font face="Comic Sans MS">Best viewed in Netscape Navigator</font></center></body></html>`;

    const result = analyzeHtml(html, ctx());
    expect(ids(result)).toContain('not-mobile-friendly');
    expect(ids(result)).toContain('no-meta-description');
    expect(ids(result)).toContain('no-og-tags');
    expect(ids(result)).not.toContain('no-title'); // a title is present
  });

  it('detects WordPress and flags an old major version as outdated tech', () => {
    const html = `<html><head>
      <meta name="viewport" content="width=device-width">
      <meta name="generator" content="WordPress 4.9.8">
      <title>Some Restaurant In Town</title>
      <link rel="stylesheet" href="https://example.com/wp-content/themes/twentyten/style.css">
      </head><body><h1>Some Restaurant</h1></body></html>`;

    const result = analyzeHtml(html, ctx());
    expect(result.tech).toMatch(/WordPress/i);
    expect(ids(result)).toContain('outdated-tech');
  });

  it('flags a stale copyright year', () => {
    const html = `<html><head>
      <meta name="viewport" content="width=device-width">
      <title>Old Shop — Antiques and Curios</title>
      </head><body>
      <h1>Old Shop</h1>
      <footer>Copyright © 2014 Old Shop. All rights reserved.</footer>
      </body></html>`;

    const result = analyzeHtml(html, ctx());
    const stale = result.issues.find((i) => i.id === 'stale-copyright');
    expect(stale).toBeDefined();
    expect(stale?.severity).toBe('minor');
    expect(stale?.detail).toContain('2014');
  });
});
