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
  makeRequireAdmin,
  makeRequireAuth,
  rateLimitAllow,
  serializeCookie,
  signSession,
} from './auth';
import { BillingService, type Plan } from './billing';
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
app.set('trust proxy', true);

/* ---- Cashfree webhook: raw body BEFORE express.json for signature check ---- */
app.post('/api/webhooks/cashfree', express.raw({ type: '*/*' }), async (req: Request, res: Response) => {
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

function setSession(res: Response, uid: string): void {
  const token = signSession({ uid, exp: Date.now() + SESSION_TTL_MS }, cfg.sessionSecret);
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
  return {
    id: userId,
    email,
    role,
    plan: {
      id: plan.id,
      name: plan.name,
      scansPerPeriod: plan.scansPerPeriod,
      maxRadiusMeters: plan.maxRadiusMeters,
      maxBusinesses: plan.maxBusinesses,
      psiAllowed: plan.psiAllowed,
    },
    subscription: {
      status: subscription.status,
      planId: subscription.planId,
      scansUsed: subscription.scansUsed,
      scansRemaining: Math.max(0, plan.scansPerPeriod - subscription.scansUsed),
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
  if (!rateLimitAllow(`register:${clientIp(req)}:${email.toLowerCase()}`)) {
    res.status(429).json({ error: 'Too many attempts. Try again later.' });
    return;
  }
  if (await userStore.byEmail(email)) {
    res.status(409).json({ error: 'An account with that email already exists.' });
    return;
  }
  const user = await userStore.create({ email, password, role: 'user' });
  setSession(res, user.id);
  res.json(await meSummary(user.id, user.email, user.role));
}));

app.post('/api/auth/login', guard(async (req: Request, res: Response) => {
  const body = req.body as { email?: unknown; password?: unknown };
  const email = typeof body.email === 'string' ? body.email.trim() : '';
  const password = typeof body.password === 'string' ? body.password : '';
  if (!rateLimitAllow(`login:${clientIp(req)}:${email.toLowerCase()}`)) {
    res.status(429).json({ error: 'Too many attempts. Try again in a few minutes.' });
    return;
  }
  const user = await userStore.byEmail(email);
  const ok = user && (await verifyPassword(password, user.passwordHash, user.salt));
  if (!user || !ok) {
    res.status(401).json({ error: 'Invalid email or password.' });
    return;
  }
  setSession(res, user.id);
  res.json(await meSummary(user.id, user.email, user.role));
}));

app.post('/api/auth/logout', (_req: Request, res: Response) => {
  clearSession(res);
  res.json({ ok: true });
});

app.get('/api/auth/me', requireAuth, guard(async (req: Request, res: Response) => {
  const user = req.user!; // requireAuth guarantees this
  res.json(await meSummary(user.id, user.email, user.role));
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
  const userRoot = join(LEADS_ROOT, req.user!.id);
  try {
    const dirs = (await readdir(userRoot, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
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
    res.json(scans.filter(Boolean));
  } catch {
    res.json([]); // no dir yet — nothing scanned
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
  if (scanRunning.get(user.id)) {
    res.status(409).json({ error: 'A scan is already running.' });
    return;
  }
  const scanReq = parseScanRequest(req.body);
  if (!scanReq) {
    res.status(400).json({ error: 'Invalid scan request: need area.center.lat/lng and radiusMeters 100..50000.' });
    return;
  }

  // Plan enforcement: quota (402), then clamp radius/businesses/PSI to plan.
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
  scanReq.outDir = join(LEADS_ROOT, user.id);

  scanRunning.set(user.id, true);
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
    scanRunning.set(user.id, false);
    res.end();
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
  if (!cfg.cashfreeAppId || !cfg.cashfreeSecretKey) {
    res.status(503).json({ error: 'Payments are not configured on this server.' });
    return;
  }
  const planId = (req.body as { planId?: string }).planId;
  const plan = planId ? await billing.getPlan(planId) : undefined;
  if (!plan || !plan.active) {
    res.status(400).json({ error: 'Unknown or inactive plan.' });
    return;
  }
  if (plan.priceINR <= 0) {
    res.status(400).json({ error: 'That plan is free — no payment needed.' });
    return;
  }
  const user = req.user!;
  const orderId = newOrderId();
  const returnUrl = `${cfg.appBaseUrl}/billing/return?order_id={order_id}`;
  const order = await createOrder(
    { appId: cfg.cashfreeAppId, secretKey: cfg.cashfreeSecretKey, baseUrl: cfg.cashfreeBaseUrl },
    {
      orderId,
      amountINR: plan.priceINR,
      customerId: user.id,
      customerEmail: user.email,
      customerPhone: user.phone || '9999999999',
      returnUrl,
      note: plan.id,
    },
  );
  await billing.createOrder({
    id: orderId,
    userId: user.id,
    planId: plan.id,
    amountINR: plan.priceINR,
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
  return {
    id,
    name,
    priceINR: Math.max(0, num(b.priceINR, 0)),
    periodDays: Math.max(1, num(b.periodDays, 30)),
    scansPerPeriod: Math.max(0, num(b.scansPerPeriod, 0)),
    maxRadiusMeters: Math.max(100, num(b.maxRadiusMeters, 1500)),
    psiAllowed: b.psiAllowed === true,
    maxBusinesses: Math.max(1, num(b.maxBusinesses, 50)),
    active: b.active !== false,
  };
}

app.get('/api/admin/users', requireAdmin, guard(async (_req: Request, res: Response) => {
  const users = await userStore.all();
  const rows = await Promise.all(
    users.map(async (u) => {
      const { plan, subscription } = await billing.effective(u.id);
      return {
        ...UserStore.publicView(u),
        planId: plan.id,
        planName: plan.name,
        scansUsed: subscription.scansUsed,
        scansPerPeriod: plan.scansPerPeriod,
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
