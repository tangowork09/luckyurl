/**
 * Hand-rolled session auth: an HMAC-signed cookie, tiny cookie parse/serialize,
 * an in-memory login rate limiter, and Express middleware.
 *
 * Cookie "ls_session" = base64url(payload).base64url(HMAC-SHA256(payload,
 * SESSION_SECRET)); payload = { uid, exp }. HttpOnly, SameSite=Lax, Secure on
 * https. No dependency on any cookie/session library.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import type { User, UserStore } from './users';

// Attach the authenticated user to the request for downstream handlers.
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: User;
    }
  }
}

export const SESSION_COOKIE = 'ls_session';
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export interface SessionPayload {
  uid: string;
  exp: number; // epoch ms
  /** tokenVersion at issue time; must equal the user's current one (revocation). */
  tv?: number;
}

const b64url = (input: Buffer | string): string => Buffer.from(input).toString('base64url');

export function signSession(payload: SessionPayload, secret: string): string {
  const body = b64url(JSON.stringify(payload));
  const sig = b64url(createHmac('sha256', secret).update(body).digest());
  return `${body}.${sig}`;
}

export function verifySession(token: string, secret: string): SessionPayload | null {
  const dot = token.indexOf('.');
  if (dot <= 0 || dot === token.length - 1) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = b64url(createHmac('sha256', secret).update(body).digest());
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  let payload: SessionPayload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as SessionPayload;
  } catch {
    return null;
  }
  if (typeof payload.uid !== 'string' || typeof payload.exp !== 'number') return null;
  if (payload.exp < Date.now()) return null;
  if (payload.tv !== undefined && typeof payload.tv !== 'number') return null;
  return payload;
}

/* -------------------------------- cookies ------------------------------- */

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const key = part.slice(0, eq).trim();
    if (!key) continue;
    const val = part.slice(eq + 1).trim();
    try {
      out[key] = decodeURIComponent(val);
    } catch {
      out[key] = val;
    }
  }
  return out;
}

export interface CookieOptions {
  maxAgeMs?: number;
  path?: string;
  httpOnly?: boolean;
  sameSite?: 'Lax' | 'Strict' | 'None';
  secure?: boolean;
}

export function serializeCookie(name: string, value: string, opts: CookieOptions = {}): string {
  let s = `${name}=${encodeURIComponent(value)}`;
  s += `; Path=${opts.path ?? '/'}`;
  if (opts.maxAgeMs != null) s += `; Max-Age=${Math.floor(opts.maxAgeMs / 1000)}`;
  if (opts.httpOnly) s += '; HttpOnly';
  if (opts.sameSite) s += `; SameSite=${opts.sameSite}`;
  if (opts.secure) s += '; Secure';
  return s;
}

/* ------------------------------ rate limit ------------------------------ */

interface Attempt {
  count: number;
  resetAt: number;
}
const attempts = new Map<string, Attempt>();

/**
 * Returns true if the action is allowed (and counts it). Sliding fixed window,
 * in-memory (single process). Used to cap login attempts per IP+email.
 */
export function rateLimitAllow(key: string, max = 10, windowMs = 15 * 60 * 1000): boolean {
  const now = Date.now();
  const rec = attempts.get(key);
  if (!rec || rec.resetAt <= now) {
    attempts.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  if (rec.count >= max) return false;
  rec.count += 1;
  return true;
}

/** Test/ops hook: clear the rate-limit table. */
export function resetRateLimits(): void {
  attempts.clear();
}

/*
 * Named limiter policies. Registration and login are each guarded by TWO
 * independent counters — one keyed by IP alone and one by email — and BOTH must
 * allow. The IP-alone counter is what blunts mass signups / credential stuffing
 * where an attacker rotates the email to keep any per-email counter at 1.
 */
export const RATE_LIMIT_POLICY = {
  /** Registrations per IP (email-independent). Blocks mass signups. */
  registerPerIp: { max: 5, windowMs: 60 * 60 * 1000 },
  /** Registrations per email (retries for one address). */
  registerPerEmail: { max: 10, windowMs: 15 * 60 * 1000 },
  /** Login attempts per email (classic brute-force guard). */
  loginPerEmail: { max: 10, windowMs: 15 * 60 * 1000 },
  /** Login attempts per IP (email-independent). Blunts credential stuffing. */
  loginPerIp: { max: 30, windowMs: 15 * 60 * 1000 },
} as const;

/** Registration limiter: per-IP AND per-email must both allow (both counted). */
export function registerRateLimitAllow(ip: string, email: string): boolean {
  const p = RATE_LIMIT_POLICY;
  const ipOk = rateLimitAllow(`register:ip:${ip}`, p.registerPerIp.max, p.registerPerIp.windowMs);
  const emailOk = rateLimitAllow(`register:email:${email.toLowerCase()}`, p.registerPerEmail.max, p.registerPerEmail.windowMs);
  return ipOk && emailOk;
}

/** Login limiter: per-IP AND per-email must both allow (both counted). */
export function loginRateLimitAllow(ip: string, email: string): boolean {
  const p = RATE_LIMIT_POLICY;
  const ipOk = rateLimitAllow(`login:ip:${ip}`, p.loginPerIp.max, p.loginPerIp.windowMs);
  const emailOk = rateLimitAllow(`login:email:${email.toLowerCase()}`, p.loginPerEmail.max, p.loginPerEmail.windowMs);
  return ipOk && emailOk;
}

/* ------------------------------ middleware ------------------------------ */

export interface AuthDeps {
  users: UserStore;
  sessionSecret: string;
}

/** Read + verify the session cookie, load the user, attach to req. Never throws. */
export async function loadUserFromRequest(req: Request, deps: AuthDeps): Promise<User | undefined> {
  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (!token) return undefined;
  const payload = verifySession(token, deps.sessionSecret);
  if (!payload) return undefined;
  const user = await deps.users.byId(payload.uid);
  if (!user) return undefined;
  // Session revocation: the cookie's tokenVersion must match the user's current
  // one. A logout / password-change bumps it, invalidating older cookies.
  if ((user.tokenVersion ?? 0) !== (payload.tv ?? 0)) return undefined;
  req.user = user;
  return user;
}

export function makeRequireAuth(deps: AuthDeps) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const user = await loadUserFromRequest(req, deps);
      if (!user) {
        res.status(401).json({ error: 'Authentication required.' });
        return;
      }
      next();
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'auth error' });
    }
  };
}

export function makeRequireAdmin(deps: AuthDeps) {
  const requireAuth = makeRequireAuth(deps);
  return (req: Request, res: Response, next: NextFunction): void => {
    void requireAuth(req, res, () => {
      if (req.user?.role !== 'admin') {
        res.status(403).json({ error: 'Admin access required.' });
        return;
      }
      next();
    });
  };
}
