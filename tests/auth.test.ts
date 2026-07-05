import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  loginRateLimitAllow,
  parseCookies,
  rateLimitAllow,
  RATE_LIMIT_POLICY,
  registerRateLimitAllow,
  resetRateLimits,
  serializeCookie,
  signSession,
  verifySession,
} from '../src/auth';
import { hashPassword, verifyPassword } from '../src/users';

describe('password hashing (scrypt)', () => {
  it('verifies a correct password and rejects a wrong one', async () => {
    const { hash, salt } = await hashPassword('correct horse battery');
    expect(await verifyPassword('correct horse battery', hash, salt)).toBe(true);
    expect(await verifyPassword('wrong password', hash, salt)).toBe(false);
  });

  it('produces a unique salt per hash', async () => {
    const a = await hashPassword('same');
    const b = await hashPassword('same');
    expect(a.salt).not.toBe(b.salt);
    expect(a.hash).not.toBe(b.hash);
  });

  it('returns false on a malformed stored hash rather than throwing', async () => {
    await expect(verifyPassword('x', 'nothex!!', 'deadbeef')).resolves.toBe(false);
  });
});

describe('session cookie sign/verify', () => {
  const secret = 'test-secret-value';

  it('round-trips a payload', () => {
    const token = signSession({ uid: 'u1', exp: Date.now() + 10_000 }, secret);
    const payload = verifySession(token, secret);
    expect(payload?.uid).toBe('u1');
  });

  it('rejects a tampered payload', () => {
    const token = signSession({ uid: 'u1', exp: Date.now() + 10_000 }, secret);
    const [body, sig] = token.split('.');
    // Flip the payload but keep the old signature.
    const forged = `${Buffer.from(JSON.stringify({ uid: 'admin', exp: Date.now() + 10_000 })).toString('base64url')}.${sig}`;
    expect(verifySession(forged, secret)).toBeNull();
    expect(body).toBeDefined();
  });

  it('rejects a wrong-secret signature', () => {
    const token = signSession({ uid: 'u1', exp: Date.now() + 10_000 }, secret);
    expect(verifySession(token, 'other-secret')).toBeNull();
  });

  it('rejects an expired session', () => {
    const token = signSession({ uid: 'u1', exp: Date.now() - 1 }, secret);
    expect(verifySession(token, secret)).toBeNull();
  });

  it('rejects garbage tokens', () => {
    expect(verifySession('not-a-token', secret)).toBeNull();
    expect(verifySession('', secret)).toBeNull();
    expect(verifySession('a.', secret)).toBeNull();
  });
});

describe('cookie parse/serialize', () => {
  it('serializes with flags and parses back', () => {
    const cookie = serializeCookie('ls_session', 'abc def', {
      httpOnly: true,
      sameSite: 'Lax',
      secure: true,
      maxAgeMs: 7000,
    });
    expect(cookie).toContain('ls_session=abc%20def');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('Max-Age=7');
    expect(parseCookies('ls_session=abc%20def; other=1').ls_session).toBe('abc def');
  });

  it('handles an absent header', () => {
    expect(parseCookies(undefined)).toEqual({});
  });
});

describe('login rate limit', () => {
  it('allows up to max then blocks', () => {
    resetRateLimits();
    const key = 'ip:test';
    for (let i = 0; i < 10; i++) expect(rateLimitAllow(key, 10, 60_000)).toBe(true);
    expect(rateLimitAllow(key, 10, 60_000)).toBe(false);
  });
});

describe('registration rate limit — per-IP cap defeats email rotation', () => {
  it('blocks mass signups from one IP even with a fresh email each time', () => {
    resetRateLimits();
    const ip = '203.0.113.9';
    const max = RATE_LIMIT_POLICY.registerPerIp.max;
    // Each attempt uses a DIFFERENT email, so the per-email counter is always 1;
    // only the per-IP counter accumulates and eventually blocks.
    for (let i = 0; i < max; i++) {
      expect(registerRateLimitAllow(ip, `fresh${i}@example.com`)).toBe(true);
    }
    expect(registerRateLimitAllow(ip, `fresh${max}@example.com`)).toBe(false);
    // A DIFFERENT IP is unaffected.
    expect(registerRateLimitAllow('198.51.100.7', 'someone@example.com')).toBe(true);
  });
});

describe('login rate limit — per-IP cap blunts credential stuffing', () => {
  it('blocks many login attempts from one IP across rotating emails', () => {
    resetRateLimits();
    const ip = '203.0.113.42';
    const max = RATE_LIMIT_POLICY.loginPerIp.max;
    for (let i = 0; i < max; i++) {
      expect(loginRateLimitAllow(ip, `victim${i}@example.com`)).toBe(true);
    }
    expect(loginRateLimitAllow(ip, `victim${max}@example.com`)).toBe(false);
  });
});

// The webhook signature formula lives in cashfree.ts but is auth-shaped; a
// self-consistent known vector guards against accidental formula drift.
describe('cashfree webhook signature (formula check)', () => {
  it('matches base64(HMAC-SHA256(timestamp + body, secret))', async () => {
    const { verifyWebhookSignature } = await import('../src/cashfree');
    const secret = 'whsec';
    const ts = '1700000000';
    const body = '{"type":"PAYMENT_SUCCESS_WEBHOOK"}';
    const sig = createHmac('sha256', secret).update(ts + body).digest('base64');
    expect(verifyWebhookSignature(ts, body, sig, secret)).toBe(true);
    expect(verifyWebhookSignature(ts, body, sig, 'wrong')).toBe(false);
    expect(verifyWebhookSignature(ts, `${body} `, sig, secret)).toBe(false);
  });
});
