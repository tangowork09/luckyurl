/**
 * Express server: auth + multi-tenant scans + billing + admin.
 *
 * Every user gets their own lead directory (leads/<userId>/…), their own CRM
 * store, and their own scan lock. Plans (free/starter/pro) cap scans-per-period,
 * radius, businesses and PSI; upgrades go through Cashfree one-time orders.
 *
 * POST /api/scan streams ProgressEvents as "data: <json>\n\n" (client reads the
 * fetch body stream, not EventSource). CRM writes bypass the scan lock so
 * status/notes stay editable. Auth is a hand-rolled HMAC-signed cookie.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import {
  SESSION_COOKIE,
  SESSION_TTL_MS,
  loadUserFromRequest,
  loginRateLimitAllow,
  makeRequireAdmin,
  makeRequireAuth,
  registerRateLimitAllow,
  serializeCookie,
  signSession,
} from './auth';
import { isDisposableEmailDomain } from './disposable-domains';
import { isWithinRetention, planHistoryDays } from './retention';
import { BillingService, BILLING_CYCLES, CYCLE_PERIOD_DAYS, usageFor, type AiFeatureLevel, type BillingCycle, type CyclePricing, type Plan } from './billing';
import { CATEGORY_GROUPS } from './categories';
import { createOrder, fetchOrder, newOrderId, verifyWebhookSignature } from './cashfree';
import { loadConfig } from './config';
import { runScan } from './scan';
import { CrmStore } from './store';
import { UserStore, verifyPassword } from './users';
import type { DataSource, LeadStatus, ProgressEvent, ScanRequest } from './types';

const DEFAULT_CENTER = { lat: 12.9758, lng: 77.6045 };
const LEADS_ROOT = resolve(process.cwd(), 'leads');
const PUBLIC_DIR = resolve(process.cwd(), 'public');
const VALID_STATUS: LeadStatus[] = ['new', 'contacted', 'interested', 'won', 'dead', 'suppressed'];

const cfg = loadConfig();
const userStore = new UserStore(cfg.dataDir);
const billing = new BillingService(cfg.dataDir);
const authDeps = { users: userStore, sessionSecret: cfg.sessionSecret };
const requireAuth = makeRequireAuth(authDeps);
const requireAdmin = makeRequireAdmin(authDeps);

// Per-user CRM stores + scan locks (one process owns them all).
const crmStores = new Map<string, CrmStore>();
function storeFor(userId: string): CrmStore {
  let s = crmStores.get(userId);
  if (!s) {
    s = new CrmStore(join(LEADS_ROOT, userId));
    crmStores.set(userId, s);
  }
  return s;
}
const scanRunning = new Map<string, boolean>();

const app = express();
// Trust EXACTLY ONE proxy hop (Railway's edge). `true` would trust the entire
// X-Forwarded-For chain, letting a client spoof req.ip and defeat IP rate-limits.
app.set('trust proxy', 1);

/*
 * Content-Security-Policy — ONE clearly-commented, easy-to-extend string.
 * The frontend loads from several CDNs; each source below is required by the
 * current app. Keep this in sync with public/ (a parallel redesign may add
 * sources — add them here rather than loosening a directive).
 *   NOTE: 'unsafe-inline' in script-src is required TODAY because index.html /
 *   login.html / billing.html contain inline <script> bootstrap blocks. Prefer
 *   a nonce/hash once the frontend redesign lands.
 *   TODO(csp-nonce): drop script-src 'unsafe-inline' after inline scripts move
 *   to external files or gain per-response nonces.
 */
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self' https://*.cashfree.com",
  "script-src 'self' 'unsafe-inline' https://unpkg.com https://*.cashfree.com https://cdnjs.cloudflare.com https://esm.sh",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://unpkg.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data: https:", // map tiles (CARTO/OSM), business favicons, PSI screenshots
  "connect-src 'self' https://nominatim.openstreetmap.org https://*.cashfree.com https://esm.sh", // esm.sh = @paper-design/shaders ESM + its submodule imports
  'frame-src https://*.cashfree.com', // Cashfree checkout modal spans sdk/payments/sandbox subdomains
].join('; ');

// Hand-rolled security headers on every response (no helmet dependency).
app.use((_req: Request, res: Response, next: NextFunction) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(self), camera=(), microphone=()');
  res.setHeader('Content-Security-Policy', CONTENT_SECURITY_POLICY);
  // HSTS only when the deployment is actually HTTPS — never over plain http.
  if (cfg.secureCookies || cfg.appBaseUrl.startsWith('https://')) {
    res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
  }
  next();
});

/* ---- Cashfree webhook: raw body BEFORE express.json for signature check ---- */
app.post('/api/webhooks/cashfree', express.raw({ type: '*/*', limit: '100kb' }), async (req: Request, res: Response) => {
  const secret = cfg.cashfreeWebhookSecret;
  if (!secret) {
    res.status(503).json({ error: 'Billing not configured.' });
    return;
  }
  const timestamp = String(req.headers['x-webhook-timestamp'] ?? '');
  const signature = String(req.headers['x-webhook-signature'] ?? '');
  const rawBody = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : String(req.body ?? '');
  if (!verifyWebhookSignature(timestamp, rawBody, signature, secret)) {
    res.status(401).json({ error: 'Invalid webhook signature.' });
    return;
  }
  try {
    const event = JSON.parse(rawBody) as { type?: string; data?: { order?: { order_id?: string } } };
    if (event.type === 'PAYMENT_SUCCESS_WEBHOOK') {
      const orderId = event.data?.order?.order_id;
      if (orderId) await billing.fulfillOrder(orderId); // idempotent
    }
  } catch (err) {
    console.error('Webhook parse/handle failed:', err instanceof Error ? err.message : err);
  }
  res.json({ ok: true }); // 200 on any validly-signed event (idempotent)
});

app.use(express.json({ limit: '100kb' }));
app.use(express.static(PUBLIC_DIR));

/* -------------------------------- ops ------------------------------- */

app.get('/healthz', (_req: Request, res: Response) => {
  res.json({ ok: true });
});

app.get('/api/config', (_req: Request, res: Response) => {
  res.json({
    demoMode: cfg.demoMode,
    source: cfg.dataSource,
    defaultCenter: DEFAULT_CENTER,
    billingEnabled: Boolean(cfg.cashfreeAppId && cfg.cashfreeSecretKey),
  });
});

/* --------------------------------- auth ----------------------------- */

function setSession(res: Response, uid: string, tokenVersion = 0): void {
  const token = signSession({ uid, exp: Date.now() + SESSION_TTL_MS, tv: tokenVersion }, cfg.sessionSecret);
  res.setHeader(
    'Set-Cookie',
    serializeCookie(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: 'Lax',
      secure: cfg.secureCookies,
      maxAgeMs: SESSION_TTL_MS,
    }),
  );
}

function clearSession(res: Response): void {
  res.setHeader(
    'Set-Cookie',
    serializeCookie(SESSION_COOKIE, '', {
      httpOnly: true,
      sameSite: 'Lax',
      secure: cfg.secureCookies,
      maxAgeMs: 0,
    }),
  );
}

async function meSummary(userId: string, email: string, role: string) {
  const { plan, subscription } = await billing.effective(userId);
  const usage = usageFor(plan, subscription);
  return {
    id: userId,
    email,
    role,
    plan: {
      id: plan.id,
      name: plan.name,
      tier: plan.tier,
      scansPerPeriod: plan.scansPerPeriod,
      maxRadiusMeters: plan.maxRadiusMeters,
      maxBusinesses: plan.maxBusinesses,
      psiAllowed: plan.psiAllowed,
      aiFeatures: plan.aiFeatures,
      prioritySupport: plan.prioritySupport,
      historyDays: planHistoryDays(plan),
    },
    subscription: {
      status: subscription.status,
      planId: subscription.planId,
      cycle: subscription.cycle ?? null,
      unlimited: usage.unlimited,
      scansUsed: usage.scansUsed,
      scansRemaining: usage.scansRemaining,
      expiresAt: subscription.expiresAt,
    },
  };
}

const clientIp = (req: Request) => req.ip || req.socket.remoteAddress || 'unknown';

app.post('/api/auth/register', guard(async (req: Request, res: Response) => {
  const body = req.body as { email?: unknown; password?: unknown };
  const email = typeof body.email === 'string' ? body.email.trim() : '';
  const password = typeof body.password === 'string' ? body.password : '';
  if (!email || !/.+@.+\..+/.test(email)) {
    res.status(400).json({ error: 'A valid email is required.' });
    return;
  }
  if (password.length < 8) {
    res.status(400).json({ error: 'Password must be at least 8 characters.' });
    return;
  }
  // Reject disposable/temp-mail domains (no email actually sent here).
  if (isDisposableEmailDomain(email)) {
    res.status(400).json({ error: 'Please use a permanent email address.' });
    return;
  }
  // Two counters: per-IP (blocks mass signups with rotating emails) AND per-email.
  if (!registerRateLimitAllow(clientIp(req), email)) {
    res.status(429).json({ error: 'Too many attempts. Try again later.' });
    return;
  }
  if (await userStore.byEmail(email)) {
    // M1 tradeoff: this 409 is technically enumerable, but the per-IP register
    // cap above makes bulk probing impractical. Message kept non-specific.
    res.status(409).json({ error: 'Could not create an account with that email.' });
    return;
  }
  const user = await userStore.create({ email, password, role: 'user' });
  // TODO(email-verification): when cfg.requireEmailVerification is turned on,
  // send a verification email here (via cfg.resendApiKey) and create the user
  // with emailVerified:false. Today emailVerified defaults true and nothing is
  // sent, so the no-verify signup UX is unchanged.
  setSession(res, user.id, user.tokenVersion);
  res.json(await meSummary(user.id, user.email, user.role));
}));

app.post('/api/auth/login', guard(async (req: Request, res: Response) => {
  const body = req.body as { email?: unknown; password?: unknown };
  const email = typeof body.email === 'string' ? body.email.trim() : '';
  const password = typeof body.password === 'string' ? body.password : '';
  // Two counters: per-email brute-force guard AND per-IP (blunts credential
  // stuffing that rotates the email across many accounts from one IP).
  if (!loginRateLimitAllow(clientIp(req), email)) {
    res.status(429).json({ error: 'Too many attempts. Try again in a few minutes.' });
    return;
  }
  const user = await userStore.byEmail(email);
  const ok = user && (await verifyPassword(password, user.passwordHash, user.salt));
  if (!user || !ok) {
    res.status(401).json({ error: 'Invalid email or password.' });
    return;
  }
  setSession(res, user.id, user.tokenVersion);
  res.json(await meSummary(user.id, user.email, user.role));
}));

app.post('/api/auth/logout', guard(async (req: Request, res: Response) => {
  // Bump tokenVersion so the just-cleared cookie can't be replayed after logout.
  const user = await loadUserFromRequest(req, authDeps);
  if (user) await userStore.bumpTokenVersion(user.id);
  clearSession(res);
  res.json({ ok: true });
}));

app.get('/api/auth/me', requireAuth, guard(async (req: Request, res: Response) => {
  const user = req.user!; // requireAuth guarantees this
  res.json(await meSummary(user.id, user.email, user.role));
}));

app.post('/api/auth/change-password', requireAuth, guard(async (req: Request, res: Response) => {
  const user = req.user!;
  const body = req.body as { currentPassword?: unknown; newPassword?: unknown };
  const current = typeof body.currentPassword === 'string' ? body.currentPassword : '';
  const next = typeof body.newPassword === 'string' ? body.newPassword : '';
  if (next.length < 8) {
    res.status(400).json({ error: 'New password must be at least 8 characters.' });
    return;
  }
  const full = await userStore.byId(user.id);
  const ok = full && (await verifyPassword(current, full.passwordHash, full.salt));
  if (!full || !ok) {
    res.status(401).json({ error: 'Current password is incorrect.' });
    return;
  }
  // updatePassword bumps tokenVersion → every OTHER session is invalidated.
  const updated = await userStore.updatePassword(user.id, next);
  // Re-issue THIS session's cookie at the new version so the caller stays in.
  setSession(res, updated!.id, updated!.tokenVersion);
  res.json({ ok: true });
}));

/* -------------------- auth gate for the rest of /api ------------------ */
// Everything under /api except config, auth/*, webhooks requires a session.
app.use((req: Request, res: Response, next: NextFunction) => {
  const p = req.path;
  if (!p.startsWith('/api/')) return next();
  if (p === '/api/config' || p.startsWith('/api/auth/') || p === '/api/webhooks/cashfree') return next();
  return void requireAuth(req, res, next);
});

/* --------------------- protected static: /leads ---------------------- */
// Auth + per-user path scoping: a user may only fetch /leads/<their-uid>/…;
// admins may fetch any user's files.
app.use(
  '/leads',
  requireAuth,
  (req: Request, res: Response, next: NextFunction) => {
    const user = req.user!;
    if (user.role === 'admin') return next();
    const first = req.path.split('/').filter(Boolean)[0];
    if (first && first === user.id) return next();
    res.status(403).json({ error: 'You can only access your own leads.' });
  },
  express.static(LEADS_ROOT, { fallthrough: true }),
);

app.get('/api/categories', (_req: Request, res: Response) => {
  res.json(CATEGORY_GROUPS);
});

app.get('/api/leads', guard(async (req: Request, res: Response) => {
  // Per-plan history retention: hide (never delete) scan dirs older than the
  // plan's window. historyDays===0 (free) locks history entirely.
  const { plan } = await billing.effective(req.user!.id);
  const historyDays = planHistoryDays(plan);
  const retentionLocked = historyDays === 0;
  if (retentionLocked) {
    res.json({ scans: [], historyDays, retentionLocked });
    return;
  }
  const userRoot = join(LEADS_ROOT, req.user!.id);
  const now = Date.now();
  try {
    const dirs = (await readdir(userRoot, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .filter((name) => isWithinRetention(name, historyDays, now))
      .sort()
      .reverse();
    const scans = await Promise.all(
      dirs.map(async (dir) => {
        try {
          const files = (await readdir(join(userRoot, dir))).filter(
            (f) => f.endsWith('.md') || f.endsWith('.json') || f === 'summary.html',
          );
          let leadCount: number | undefined;
          try {
            const raw = JSON.parse(await readFile(join(userRoot, dir, 'leads.json'), 'utf8')) as { leads?: unknown[] };
            leadCount = Array.isArray(raw.leads) ? raw.leads.length : undefined;
          } catch {
            /* leads.json missing/unreadable — leave count undefined */
          }
          return { dir, files, leadCount };
        } catch {
          return null;
        }
      }),
    );
    res.json({ scans: scans.filter(Boolean), historyDays, retentionLocked });
  } catch {
    res.json({ scans: [], historyDays, retentionLocked }); // no dir yet — nothing scanned
  }
}));

/* ------------------------------- CRM ------------------------------ */

/** Wrap async handlers so Express 4 doesn't hang on a rejection. */
function guard(fn: (req: Request, res: Response) => Promise<void>) {
  return async (req: Request, res: Response) => {
    try {
      await fn(req, res);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('Request failed:', message);
      if (!res.headersSent) res.status(500).json({ error: message });
    }
  };
}

app.get('/api/pipeline', guard(async (req: Request, res: Response) => {
  const store = storeFor(req.user!.id);
  await store.load();
  const status = typeof req.query.status === 'string' ? req.query.status : '';
  const tag = typeof req.query.tag === 'string' ? req.query.tag.toLowerCase() : '';
  const q = typeof req.query.q === 'string' ? req.query.q.toLowerCase() : '';
  const rows = store.all().filter((r) => {
    if (status && r.status !== status) return false;
    if (tag && !r.tags.some((t) => t.toLowerCase() === tag)) return false;
    if (q && !`${r.businessSnapshot.name} ${r.businessSnapshot.phone ?? ''}`.toLowerCase().includes(q)) return false;
    return true;
  });
  res.json(rows);
}));

app.get('/api/followups', guard(async (req: Request, res: Response) => {
  const store = storeFor(req.user!.id);
  await store.load();
  const due = store
    .all()
    .filter((r) => r.followUpAt && !r.suppressed)
    .sort((a, b) => (a.followUpAt! < b.followUpAt! ? -1 : 1));
  res.json(due);
}));

app.post('/api/leads/:id/status', guard(async (req: Request, res: Response) => {
  const status = (req.body as { status?: string }).status;
  if (!status || !VALID_STATUS.includes(status as LeadStatus)) {
    res.status(400).json({ error: `status must be one of ${VALID_STATUS.join(', ')}` });
    return;
  }
  res.json(await storeFor(req.user!.id).setStatus(req.params.id, status as LeadStatus));
}));

app.post('/api/leads/:id/note', guard(async (req: Request, res: Response) => {
  const text = (req.body as { text?: string }).text;
  if (!text || typeof text !== 'string') {
    res.status(400).json({ error: 'note text required' });
    return;
  }
  res.json(await storeFor(req.user!.id).addNote(req.params.id, text.slice(0, 2000)));
}));

app.post('/api/leads/:id/followup', guard(async (req: Request, res: Response) => {
  const at = (req.body as { at?: string }).at;
  res.json(await storeFor(req.user!.id).setFollowUp(req.params.id, typeof at === 'string' ? at : undefined));
}));

app.get('/api/export.csv', guard(async (req: Request, res: Response) => {
  const store = storeFor(req.user!.id);
  await store.load();
  const cell = (v: unknown) => {
    let s = String(v ?? '');
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // neutralise spreadsheet formula injection
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const header = ['name', 'phone', 'email', 'status', 'tags', 'followUpAt', 'lastContactedAt', 'kind', 'score', 'address'];
  const lines = [header.join(',')];
  for (const r of store.all()) {
    const b = r.businessSnapshot;
    lines.push(
      [b.name, b.phone, b.email, r.status, r.tags.join('|'), r.followUpAt, r.lastContactedAt, b.kind, b.leadScore, b.address]
        .map(cell)
        .join(','),
    );
  }
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="leadscout-pipeline.csv"');
  res.send(lines.join('\n'));
}));

/* ------------------------------ scan ------------------------------ */

function parseScanRequest(body: unknown): ScanRequest | null {
  if (typeof body !== 'object' || body === null) return null;
  const raw = body as Record<string, unknown>;
  const area = raw.area as { center?: { lat?: unknown; lng?: unknown }; radiusMeters?: unknown } | undefined;
  const lat = Number(area?.center?.lat);
  const lng = Number(area?.center?.lng);
  const radius = Number(area?.radiusMeters);
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) return null;
  if (!Number.isFinite(lng) || lng < -180 || lng > 180) return null;
  if (!Number.isFinite(radius) || radius < 100 || radius > 50_000) return null;

  const categories = Array.isArray(raw.categories)
    ? raw.categories.filter((c): c is string => typeof c === 'string').slice(0, 50)
    : [];
  const maxRaw = Number(raw.maxBusinesses);
  const packRaw = Number(raw.pack);
  const req: ScanRequest = {
    area: { center: { lat, lng }, radiusMeters: radius },
    categories,
    psi: raw.psi === true,
    draft: raw.draft === true,
  };
  if (Number.isFinite(maxRaw)) req.maxBusinesses = Math.min(Math.max(Math.floor(maxRaw), 1), 2000);
  if (Number.isFinite(packRaw) && packRaw > 0) req.pack = Math.min(Math.floor(packRaw), 50);
  return req;
}

app.post('/api/scan', async (req: Request, res: Response) => {
  const user = req.user!;
  // Reserve the per-user scan lock SYNCHRONOUSLY — between this get() and set()
  // there is no await, so two concurrent requests can't both pass the guard.
  if (scanRunning.get(user.id)) {
    res.status(409).json({ error: 'A scan is already running.' });
    return;
  }
  scanRunning.set(user.id, true);
  // Single try/finally guarantees the lock is cleared on EVERY exit path —
  // validation 400, quota 402, billing 500, scan error, or normal stream end.
  try {
    const scanReq = parseScanRequest(req.body);
    if (!scanReq) {
      res.status(400).json({ error: 'Invalid scan request: need area.center.lat/lng and radiusMeters 100..50000.' });
      return;
    }

    // Plan enforcement: quota (402), then clamp radius/businesses/PSI to plan.
    // consumeScan is atomic per user, so the lock + this check both prevent
    // over-consumption under concurrency.
    let consume;
    try {
      consume = await billing.consumeScan(user.id);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'billing error' });
      return;
    }
    if (!consume.ok) {
      res.status(402).json({ error: consume.reason, planId: consume.plan.id, upgrade: true });
      return;
    }
    const plan = consume.plan;
    scanReq.area.radiusMeters = Math.min(scanReq.area.radiusMeters, plan.maxRadiusMeters);
    scanReq.maxBusinesses = Math.min(scanReq.maxBusinesses ?? plan.maxBusinesses, plan.maxBusinesses);
    if (!plan.psiAllowed) scanReq.psi = false;
    // AI feature gating: local-model draft generation (draft.ts via `ensemble`)
    // is the only AI surface today. Free (aiFeatures 'none') can't use it.
    // TODO(ai-gating): when richer AI endpoints land (e.g. rewrite/expand a pitch),
    // branch on plan.aiFeatures — 'basic' unlocks entry-level AI, 'full' unlocks
    // everything — both here and at those new endpoints.
    if (plan.aiFeatures === 'none') scanReq.draft = false;
    scanReq.outDir = join(LEADS_ROOT, user.id);

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders?.();

    const abort = new AbortController();
    res.on('close', () => abort.abort());

    const send = (e: ProgressEvent) => {
      if (!abort.signal.aborted) res.write(`data: ${JSON.stringify(e)}\n\n`);
    };

    try {
      await runScan(cfg, scanReq, send, { store: storeFor(user.id), signal: abort.signal });
    } catch (err) {
      console.error('Scan failed:', err instanceof Error ? err.message : err);
    } finally {
      res.end();
    }
  } finally {
    scanRunning.set(user.id, false);
  }
});

/* ------------------------------ billing ---------------------------- */

app.get('/api/billing/plans', guard(async (req: Request, res: Response) => {
  const plans = await billing.activePlans();
  const current = await billing.effective(req.user!.id);
  res.json({
    plans,
    current: { plan: current.plan, subscription: current.subscription },
    billingEnabled: Boolean(cfg.cashfreeAppId && cfg.cashfreeSecretKey),
  });
}));

app.post('/api/billing/checkout', guard(async (req: Request, res: Response) => {
  // Validate the request (plan + cycle + price) BEFORE the Cashfree-config
  // check so bad requests always 400, even when payments aren't wired up.
  const body = req.body as { planId?: string; cycle?: string };
  const plan = body.planId ? await billing.getPlan(body.planId) : undefined;
  if (!plan || !plan.active) {
    res.status(400).json({ error: 'Unknown or inactive plan.' });
    return;
  }
  const cycle = body.cycle;
  if (!cycle || !BILLING_CYCLES.includes(cycle as BillingCycle)) {
    res.status(400).json({ error: `cycle must be one of ${BILLING_CYCLES.join(', ')}.` });
    return;
  }
  const pricing = plan.pricing[cycle as BillingCycle];
  if (!pricing) {
    res.status(400).json({ error: `The ${plan.name} plan does not offer a ${cycle} billing cycle.` });
    return;
  }
  if (pricing.price <= 0) {
    res.status(400).json({ error: 'That plan is free — no payment needed.' });
    return;
  }

  if (!cfg.cashfreeAppId || !cfg.cashfreeSecretKey) {
    res.status(503).json({ error: 'Payments are not configured on this server.' });
    return;
  }
  const user = req.user!;
  const orderId = newOrderId();
  const returnUrl = `${cfg.appBaseUrl}/billing/return?order_id={order_id}`;
  const order = await createOrder(
    { appId: cfg.cashfreeAppId, secretKey: cfg.cashfreeSecretKey, baseUrl: cfg.cashfreeBaseUrl },
    {
      orderId,
      amountINR: pricing.price,
      customerId: user.id,
      customerEmail: user.email,
      customerPhone: user.phone || '9999999999',
      returnUrl,
      note: `${plan.id}:${cycle}`,
    },
  );
  await billing.createOrder({
    id: orderId,
    userId: user.id,
    planId: plan.id,
    cycle: cycle as BillingCycle,
    amountINR: pricing.price,
    paymentSessionId: order.payment_session_id,
  });
  res.json({ payment_session_id: order.payment_session_id, order_id: orderId, mode: cfg.cashfreeEnv });
}));

app.get('/api/billing/order/:orderId', guard(async (req: Request, res: Response) => {
  const user = req.user!;
  const order = await billing.getOrder(req.params.orderId);
  if (!order || order.userId !== user.id) {
    res.status(404).json({ error: 'Order not found.' });
    return;
  }
  if (order.status === 'paid') {
    res.json({ status: 'PAID', planId: order.planId, activated: true });
    return;
  }
  // Fallback verify when the webhook is delayed/undeliverable (e.g. localhost).
  if (cfg.cashfreeAppId && cfg.cashfreeSecretKey) {
    try {
      const remote = await fetchOrder(
        { appId: cfg.cashfreeAppId, secretKey: cfg.cashfreeSecretKey, baseUrl: cfg.cashfreeBaseUrl },
        order.id,
      );
      if (remote.order_status === 'PAID') {
        await billing.fulfillOrder(order.id); // idempotent with the webhook
        res.json({ status: 'PAID', planId: order.planId, activated: true });
        return;
      }
      res.json({ status: remote.order_status, planId: order.planId, activated: false });
      return;
    } catch (err) {
      res.status(502).json({ error: err instanceof Error ? err.message : 'verify failed' });
      return;
    }
  }
  res.json({ status: order.status, planId: order.planId, activated: false });
}));

// Return page (HTML) after Cashfree redirects back.
app.get('/billing/return', (_req: Request, res: Response) => {
  res.sendFile(join(PUBLIC_DIR, 'billing.html'));
});

/* ------------------------------- admin ----------------------------- */

function validatePlan(body: unknown): Plan | null {
  if (typeof body !== 'object' || body === null) return null;
  const b = body as Record<string, unknown>;
  const id = typeof b.id === 'string' ? b.id.trim() : '';
  const name = typeof b.name === 'string' ? b.name.trim() : '';
  if (!id || !name) return null;
  const num = (v: unknown, d: number) => (Number.isFinite(Number(v)) ? Math.floor(Number(v)) : d);

  const aiRaw = typeof b.aiFeatures === 'string' ? b.aiFeatures : 'none';
  const aiFeatures: AiFeatureLevel = aiRaw === 'full' ? 'full' : aiRaw === 'basic' ? 'basic' : 'none';

  // Build the per-cycle pricing map. Accept either a nested `pricing` object or
  // flat admin-form fields (monthlyPrice/monthlyMrp/yearlyPrice/…/lifetimePrice).
  const pricing: Partial<Record<BillingCycle, CyclePricing>> = {};
  const cyclePrice = (cycle: BillingCycle, price: number, mrp: number) => {
    if (price > 0) pricing[cycle] = { price, mrp: Math.max(mrp, price), periodDays: CYCLE_PERIOD_DAYS[cycle] };
  };
  const nested = b.pricing;
  if (nested && typeof nested === 'object') {
    for (const cycle of BILLING_CYCLES) {
      const cp = (nested as Record<string, unknown>)[cycle] as { price?: unknown; mrp?: unknown } | undefined;
      if (cp) cyclePrice(cycle, Math.max(0, num(cp.price, 0)), Math.max(0, num(cp.mrp, 0)));
    }
  } else {
    cyclePrice('monthly', Math.max(0, num(b.monthlyPrice, 0)), Math.max(0, num(b.monthlyMrp, 0)));
    cyclePrice('yearly', Math.max(0, num(b.yearlyPrice, 0)), Math.max(0, num(b.yearlyMrp, 0)));
    cyclePrice('lifetime', Math.max(0, num(b.lifetimePrice, 0)), Math.max(0, num(b.lifetimeMrp, 0)));
  }

  const badge = b.badge === 'popular' ? 'popular' : b.badge === 'best-value' ? 'best-value' : undefined;

  const plan: Plan = {
    id,
    name,
    tier: Math.max(0, num(b.tier, 1)),
    scansPerPeriod: Math.max(0, num(b.scansPerPeriod, 0)),
    maxRadiusMeters: Math.max(100, num(b.maxRadiusMeters, 1500)),
    maxBusinesses: Math.max(1, num(b.maxBusinesses, 50)),
    psiAllowed: b.psiAllowed === true,
    aiFeatures,
    prioritySupport: b.prioritySupport === true,
    historyDays: Math.max(0, num(b.historyDays, 0)),
    pricing,
    active: b.active !== false,
  };
  if (badge) plan.badge = badge;
  return plan;
}

app.get('/api/admin/users', requireAdmin, guard(async (_req: Request, res: Response) => {
  const users = await userStore.all();
  const rows = await Promise.all(
    users.map(async (u) => {
      const { plan, subscription } = await billing.effective(u.id);
      const usage = usageFor(plan, subscription);
      return {
        ...UserStore.publicView(u),
        planId: plan.id,
        planName: plan.name,
        cycle: subscription.cycle ?? null,
        scansUsed: usage.scansUsed,
        scansPerPeriod: plan.scansPerPeriod,
        unlimited: usage.unlimited,
        status: subscription.status,
        expiresAt: subscription.expiresAt,
      };
    }),
  );
  res.json(rows);
}));

app.get('/api/admin/plans', requireAdmin, guard(async (_req: Request, res: Response) => {
  res.json(await billing.allPlans());
}));

app.post('/api/admin/plans', requireAdmin, guard(async (req: Request, res: Response) => {
  const plan = validatePlan(req.body);
  if (!plan) {
    res.status(400).json({ error: 'Plan requires id and name.' });
    return;
  }
  res.json(await billing.upsertPlan(plan));
}));

app.put('/api/admin/plans/:id', requireAdmin, guard(async (req: Request, res: Response) => {
  const plan = validatePlan({ ...(req.body as object), id: req.params.id });
  if (!plan) {
    res.status(400).json({ error: 'Plan requires id and name.' });
    return;
  }
  res.json(await billing.upsertPlan(plan));
}));

app.post('/api/admin/users/:id/subscription', requireAdmin, guard(async (req: Request, res: Response) => {
  const body = req.body as { planId?: string; days?: unknown };
  const target = await userStore.byId(req.params.id);
  if (!target) {
    res.status(404).json({ error: 'User not found.' });
    return;
  }
  const days = Number(body.days);
  const sub = await billing.grant(target.id, String(body.planId), Number.isFinite(days) ? days : 30);
  if (!sub) {
    res.status(400).json({ error: 'Unknown plan.' });
    return;
  }
  res.json(sub);
}));

app.post('/api/admin/users/:id/revoke', requireAdmin, guard(async (req: Request, res: Response) => {
  const target = await userStore.byId(req.params.id);
  if (!target) {
    res.status(404).json({ error: 'User not found.' });
    return;
  }
  res.json(await billing.revoke(target.id));
}));

app.get('/api/admin/orders', requireAdmin, guard(async (_req: Request, res: Response) => {
  res.json((await billing.allOrders()).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)));
}));

/* ------------------------------ boot ------------------------------- */

const SOURCE_LABEL: Record<DataSource, string> = {
  google: 'Google Places',
  osm: 'OpenStreetMap (free, no key)',
  apify: 'Apify scraper (paid)',
  demo: 'demo data',
};

async function bootstrap(): Promise<void> {
  await billing.init();
  await userStore.load();
  if (!(await userStore.hasAdmin())) {
    if (cfg.adminPassword) {
      await userStore.create({ email: cfg.adminEmail, password: cfg.adminPassword, role: 'admin' });
      console.log(`Seeded admin account: ${cfg.adminEmail}`);
    } else {
      console.warn('No admin user and ADMIN_PASSWORD unset — set ADMIN_EMAIL + ADMIN_PASSWORD to seed one.');
    }
  }
}

bootstrap()
  .then(() => {
    app.listen(cfg.port, () => {
      console.log(`LeadScout [${SOURCE_LABEL[cfg.dataSource]}] on ${cfg.appBaseUrl}`);
    });
  })
  .catch((err) => {
    console.error('Failed to start:', err instanceof Error ? err.message : err);
    process.exit(1);
  });

export { app };
