import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BillingService,
  FREE_LIFETIME_SCANS,
  FREE_PLAN_ID,
  UNLIMITED_SCANS,
  usageFor,
  type Subscription,
} from '../src/billing';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'leadscout-billing-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function fresh(): Promise<BillingService> {
  const b = new BillingService(dir);
  await b.init();
  return b;
}

const DAY = 24 * 60 * 60 * 1000;

describe('plan seeding', () => {
  it('seeds free/starter/pro/lifetime on first init', async () => {
    const b = await fresh();
    const plans = await b.allPlans();
    expect(plans.map((p) => p.id)).toEqual(['free', 'starter', 'pro', 'lifetime']); // sorted by tier

    const free = await b.getPlan('free');
    expect(free?.scansPerPeriod).toBe(2);
    expect(free?.psiAllowed).toBe(false);
    expect(free?.aiFeatures).toBe('none');
    expect(free?.pricing).toEqual({}); // free has no purchasable pricing
  });

  it('seeds the exact prices + mrp + cycles per tier', async () => {
    const b = await fresh();
    const starter = (await b.getPlan('starter'))!;
    expect(starter.pricing.monthly).toEqual({ price: 450, mrp: 900, periodDays: 30 });
    expect(starter.pricing.yearly).toEqual({ price: 4500, mrp: 10800, periodDays: 365 });
    expect(starter.aiFeatures).toBe('basic');

    const pro = (await b.getPlan('pro'))!;
    expect(pro.pricing.monthly).toEqual({ price: 950, mrp: 3000, periodDays: 30 });
    expect(pro.pricing.yearly).toEqual({ price: 9500, mrp: 36000, periodDays: 365 });
    expect(pro.badge).toBe('popular');
    expect(pro.aiFeatures).toBe('full');

    const lifetime = (await b.getPlan('lifetime'))!;
    expect(lifetime.pricing.lifetime).toEqual({ price: 15000, mrp: 43000, periodDays: null });
    expect(lifetime.pricing.monthly).toBeUndefined();
    expect(lifetime.badge).toBe('best-value');
    expect(lifetime.prioritySupport).toBe(true);
    expect(lifetime.scansPerPeriod).toBe(UNLIMITED_SCANS);

    // Yearly is exactly monthly×10 (price) and monthly-mrp×12.
    expect(starter.pricing.yearly!.price).toBe(starter.pricing.monthly!.price * 10);
    expect(starter.pricing.yearly!.mrp).toBe(starter.pricing.monthly!.mrp * 12);
    expect(pro.pricing.yearly!.price).toBe(pro.pricing.monthly!.price * 10);
    expect(pro.pricing.yearly!.mrp).toBe(pro.pricing.monthly!.mrp * 12);
  });

  it('does not reseed if plans already exist', async () => {
    const b = await fresh();
    await b.upsertPlan({ ...(await b.getPlan('free'))!, scansPerPeriod: 99 });
    const b2 = await fresh(); // re-init on same dir
    expect((await b2.getPlan('free'))?.scansPerPeriod).toBe(99);
  });
});

describe('effective plan', () => {
  it('gives a new user the implicit free plan', async () => {
    const b = await fresh();
    const { plan, subscription } = await b.effective('user-a');
    expect(plan.id).toBe(FREE_PLAN_ID);
    expect(subscription.scansUsed).toBe(0);
    expect(subscription.freeScansUsed).toBe(0);
    expect(subscription.expiresAt).toBeNull(); // free never "expires"
    expect(subscription.status).toBe('active');
  });
});

describe('free tier — 2 lifetime scans, no rollover', () => {
  it('allows exactly 2 free scans then rejects (402 logic)', async () => {
    const b = await fresh();
    for (let i = 0; i < FREE_LIFETIME_SCANS; i++) {
      const r = await b.consumeScan('user-a');
      expect(r.ok).toBe(true);
    }
    const blocked = await b.consumeScan('user-a');
    expect(blocked.ok).toBe(false);
    expect(blocked.reason).toMatch(/upgrade/i);
    expect(blocked.subscription.freeScansUsed).toBe(2);
  });

  it('does NOT roll over free scans after the 30-day window', async () => {
    const b = await fresh();
    await b.consumeScan('user-a');
    await b.consumeScan('user-a');

    // Rewind periodStart well past 30 days on disk — free must not reset.
    const path = join(dir, 'subscriptions.json');
    const subs = JSON.parse(await readFile(path, 'utf8')) as Subscription[];
    const old = new Date(Date.now() - 90 * DAY).toISOString();
    for (const s of subs) if (s.userId === 'user-a') s.periodStart = old;
    await writeFile(path, JSON.stringify(subs), 'utf8');

    const b2 = new BillingService(dir);
    await b2.init();
    const eff = await b2.effective('user-a');
    expect(eff.subscription.freeScansUsed).toBe(2); // still consumed
    const blocked = await b2.consumeScan('user-a');
    expect(blocked.ok).toBe(false); // still capped, no rollover
  });

  it('tracks free usage independently per user', async () => {
    const b = await fresh();
    await b.consumeScan('user-a');
    await b.consumeScan('user-a');
    await b.consumeScan('user-b');
    expect((await b.effective('user-a')).subscription.freeScansUsed).toBe(2);
    expect((await b.effective('user-b')).subscription.freeScansUsed).toBe(1);
  });
});

describe('consumeScan atomicity (H3 scan-quota race)', () => {
  it('two concurrent consumes with 1 scan left let exactly one succeed', async () => {
    const b = await fresh();
    // Free tier = 2 lifetime scans. Burn one, leaving exactly 1.
    const first = await b.consumeScan('user-a');
    expect(first.ok).toBe(true);
    expect(first.subscription.freeScansUsed).toBe(1);

    // Fire two at once against the last remaining scan.
    const [r1, r2] = await Promise.all([b.consumeScan('user-a'), b.consumeScan('user-a')]);
    const okCount = [r1, r2].filter((r) => r.ok).length;
    expect(okCount).toBe(1); // NOT 2 — the per-user mutex serialized the read-modify-write

    // Final persisted count is exactly the cap (2), never overshoots.
    expect((await b.effective('user-a')).subscription.freeScansUsed).toBe(2);
  });

  it('serializes a burst so a fresh free user consumes at most the cap', async () => {
    const b = await fresh();
    const results = await Promise.all(Array.from({ length: 5 }, () => b.consumeScan('user-b')));
    expect(results.filter((r) => r.ok).length).toBe(FREE_LIFETIME_SCANS);
    expect((await b.effective('user-b')).subscription.freeScansUsed).toBe(FREE_LIFETIME_SCANS);
  });
});

describe('history retention (feature) seed', () => {
  it('seeds historyDays per tier: free=0, starter=2, pro=30, lifetime=3650', async () => {
    const b = await fresh();
    expect((await b.getPlan('free'))?.historyDays).toBe(0);
    expect((await b.getPlan('starter'))?.historyDays).toBe(2);
    expect((await b.getPlan('pro'))?.historyDays).toBe(30);
    expect((await b.getPlan('lifetime'))?.historyDays).toBe(3650);
  });
});

describe('paid activation + cycle expiry', () => {
  it('activates a monthly sub expiring in ~30 days and resets scansUsed', async () => {
    const b = await fresh();
    const starter = (await b.getPlan('starter'))!;
    const sub = await b.activateSubscription('user-a', starter, 'monthly', 'ls_order1');
    expect(sub.cycle).toBe('monthly');
    const dt = new Date(sub.expiresAt!).getTime() - Date.now();
    expect(dt).toBeGreaterThan(29 * DAY);
    expect(dt).toBeLessThan(31 * DAY);
    expect(sub.scansUsed).toBe(0);

    const eff = await b.effective('user-a');
    expect(eff.plan.id).toBe('starter');
    expect(eff.plan.scansPerPeriod).toBe(25);
  });

  it('activates a yearly sub expiring in ~365 days', async () => {
    const b = await fresh();
    const pro = (await b.getPlan('pro'))!;
    const sub = await b.activateSubscription('user-a', pro, 'yearly');
    const dt = new Date(sub.expiresAt!).getTime() - Date.now();
    expect(dt).toBeGreaterThan(364 * DAY);
    expect(dt).toBeLessThan(366 * DAY);
  });

  it('paid period rollover still resets scansUsed on re-activation', async () => {
    const b = await fresh();
    const pro = (await b.getPlan('pro'))!;
    await b.activateSubscription('user-a', pro, 'monthly');
    await b.consumeScan('user-a');
    await b.consumeScan('user-a');
    expect((await b.effective('user-a')).subscription.scansUsed).toBe(2);
    // Re-activating (renewal) starts a fresh period.
    const renewed = await b.activateSubscription('user-a', pro, 'monthly');
    expect(renewed.scansUsed).toBe(0);
  });

  it('downgrades a paid plan after expiry, preserving lifetime free usage', async () => {
    const b = await fresh();
    // User first burns their 2 free scans, then upgrades.
    await b.consumeScan('user-a');
    await b.consumeScan('user-a');
    const pro = (await b.getPlan('pro'))!;
    await b.activateSubscription('user-a', pro, 'monthly', 'ls_order1');
    let eff = await b.effective('user-a');
    expect(eff.plan.id).toBe('pro');
    expect(eff.subscription.cashfreeOrderId).toBe('ls_order1');
    expect(eff.subscription.freeScansUsed).toBe(2); // carried through the upgrade

    // Force expiry on disk, reload, expect fallback to free.
    const path = join(dir, 'subscriptions.json');
    const subs = JSON.parse(await readFile(path, 'utf8')) as Subscription[];
    for (const s of subs) if (s.userId === 'user-a') s.expiresAt = new Date(Date.now() - 1000).toISOString();
    await writeFile(path, JSON.stringify(subs), 'utf8');

    const b2 = new BillingService(dir);
    await b2.init();
    eff = await b2.effective('user-a');
    expect(eff.plan.id).toBe(FREE_PLAN_ID);
    expect(eff.subscription.freeScansUsed).toBe(2); // NOT reset on downgrade

    // So the downgraded user has 0 free scans left and is blocked.
    const blocked = await b2.consumeScan('user-a');
    expect(blocked.ok).toBe(false);
  });
});

describe('lifetime purchase never expires', () => {
  it('stores null expiresAt and never downgrades', async () => {
    const b = await fresh();
    const lifetime = (await b.getPlan('lifetime'))!;
    const sub = await b.activateSubscription('user-a', lifetime, 'lifetime', 'ls_life');
    expect(sub.expiresAt).toBeNull();
    expect(sub.cycle).toBe('lifetime');

    // Even far in the future the lifetime plan stays active.
    const path = join(dir, 'subscriptions.json');
    const subs = JSON.parse(await readFile(path, 'utf8')) as Subscription[];
    // Nudge startedAt way back; expiresAt stays null.
    for (const s of subs) if (s.userId === 'user-a') s.startedAt = new Date(Date.now() - 5000 * DAY).toISOString();
    await writeFile(path, JSON.stringify(subs), 'utf8');

    const b2 = new BillingService(dir);
    await b2.init();
    const eff = await b2.effective('user-a');
    expect(eff.plan.id).toBe('lifetime');
    expect(eff.subscription.expiresAt).toBeNull();
  });

  it('reports unlimited usage for the lifetime tier', async () => {
    const b = await fresh();
    const lifetime = (await b.getPlan('lifetime'))!;
    await b.activateSubscription('user-a', lifetime, 'lifetime');
    const eff = await b.effective('user-a');
    const usage = usageFor(eff.plan, eff.subscription);
    expect(usage.unlimited).toBe(true);
    expect(usage.scansRemaining).toBeNull();
  });
});

describe('order fulfillment idempotency + cycle price', () => {
  it('picks the cycle amount and activates the right expiry (webhook + return share this path)', async () => {
    const b = await fresh();
    await b.createOrder({ id: 'ls_o1', userId: 'user-a', planId: 'starter', cycle: 'yearly', amountINR: 4500 });

    const first = await b.fulfillOrder('ls_o1');
    expect(first).toEqual({ found: true, alreadyPaid: false, activated: true });
    const eff = await b.effective('user-a');
    expect(eff.plan.id).toBe('starter');
    expect(eff.subscription.cycle).toBe('yearly');
    const dt = new Date(eff.subscription.expiresAt!).getTime() - Date.now();
    expect(dt).toBeGreaterThan(364 * DAY); // yearly expiry

    const second = await b.fulfillOrder('ls_o1');
    expect(second).toEqual({ found: true, alreadyPaid: true, activated: false });

    const missing = await b.fulfillOrder('nope');
    expect(missing.found).toBe(false);
  });

  it('a lifetime order activates a never-expiring sub', async () => {
    const b = await fresh();
    await b.createOrder({ id: 'ls_life', userId: 'user-a', planId: 'lifetime', cycle: 'lifetime', amountINR: 15000 });
    await b.fulfillOrder('ls_life');
    const eff = await b.effective('user-a');
    expect(eff.plan.id).toBe('lifetime');
    expect(eff.subscription.expiresAt).toBeNull();
  });

  it('marks the persisted order paid', async () => {
    const b = await fresh();
    await b.createOrder({ id: 'ls_o2', userId: 'user-a', planId: 'pro', cycle: 'monthly', amountINR: 950 });
    await b.fulfillOrder('ls_o2');
    expect((await b.getOrder('ls_o2'))?.status).toBe('paid');
  });
});

describe('admin grant + revoke', () => {
  it('grants a plan for N days and revokes back to free', async () => {
    const b = await fresh();
    const sub = await b.grant('user-a', 'pro', 7);
    expect(sub?.planId).toBe('pro');
    const grantedExpiry = new Date(sub!.expiresAt!).getTime() - Date.now();
    expect(grantedExpiry).toBeGreaterThan(6 * DAY);
    expect(grantedExpiry).toBeLessThan(8 * DAY);

    await b.revoke('user-a');
    expect((await b.effective('user-a')).plan.id).toBe(FREE_PLAN_ID);
  });

  it('grants the lifetime plan as never-expiring', async () => {
    const b = await fresh();
    const sub = await b.grant('user-a', 'lifetime', 30);
    expect(sub?.expiresAt).toBeNull();
    expect(sub?.cycle).toBe('lifetime');
  });

  it('revoke preserves lifetime free usage', async () => {
    const b = await fresh();
    await b.consumeScan('user-a'); // burns 1 free scan
    await b.grant('user-a', 'pro', 30);
    await b.revoke('user-a');
    expect((await b.effective('user-a')).subscription.freeScansUsed).toBe(1);
  });

  it('returns undefined granting an unknown plan', async () => {
    const b = await fresh();
    expect(await b.grant('user-a', 'ghost', 30)).toBeUndefined();
  });
});

describe('checkout no-op re-purchase guard (same plan + cycle)', () => {
  // The /api/billing/checkout route rejects a re-buy of the plan the user is
  // already on (400 "You're already on this plan.") to stop the free-quota-
  // refresh exploit. There is no HTTP route harness, so we exercise the exact
  // predicate the route relies on: effective() reporting an active paid tier
  // with a matching planId + cycle (block), vs. a lazily-downgraded free sub
  // (tier 0 → allow re-buy).
  const isSamePlan = (eff: Awaited<ReturnType<BillingService['effective']>>, planId: string, cycle: string) =>
    eff.plan.tier > 0 && eff.subscription.planId === planId && eff.subscription.cycle === cycle;

  it('an active paid sub reports the same plan + cycle it was activated on', async () => {
    const b = await fresh();
    const pro = (await b.getPlan('pro'))!;
    await b.activateSubscription('user-a', pro, 'monthly');
    const eff = await b.effective('user-a');
    // Guard fires for the identical plan+cycle...
    expect(isSamePlan(eff, 'pro', 'monthly')).toBe(true);
    // ...but not for a different cycle or a different plan (legitimate switch).
    expect(isSamePlan(eff, 'pro', 'yearly')).toBe(false);
    expect(isSamePlan(eff, 'starter', 'monthly')).toBe(false);
  });

  it('lifetime-on-lifetime is treated as the same plan + cycle (blocked)', async () => {
    const b = await fresh();
    const lifetime = (await b.getPlan('lifetime'))!;
    await b.activateSubscription('user-a', lifetime, 'lifetime');
    expect(isSamePlan(await b.effective('user-a'), 'lifetime', 'lifetime')).toBe(true);
  });

  it('an expired paid sub reads as free (tier 0) so a re-buy is allowed', async () => {
    const b = await fresh();
    const pro = (await b.getPlan('pro'))!;
    await b.activateSubscription('user-a', pro, 'monthly');
    // Force expiry on disk, reload → effective() lazily downgrades to free.
    const path = join(dir, 'subscriptions.json');
    const subs = JSON.parse(await readFile(path, 'utf8')) as Subscription[];
    for (const s of subs) if (s.userId === 'user-a') s.expiresAt = new Date(Date.now() - 1000).toISOString();
    await writeFile(path, JSON.stringify(subs), 'utf8');

    const b2 = new BillingService(dir);
    await b2.init();
    const eff = await b2.effective('user-a');
    expect(eff.plan.tier).toBe(0);
    expect(isSamePlan(eff, 'pro', 'monthly')).toBe(false); // guard does NOT fire
  });

  it('a fresh free user is never blocked (tier 0)', async () => {
    const b = await fresh();
    const eff = await b.effective('user-a');
    expect(isSamePlan(eff, 'free', undefined as unknown as string)).toBe(false);
  });
});

describe('prorationCredit — unused-time credit for in-cycle switches', () => {
  // Move a user's sub so exactly `remainingDays` of unused time is left (credit
  // keys off expiresAt, not startedAt).
  async function setRemaining(remainingDays: number): Promise<void> {
    const path = join(dir, 'subscriptions.json');
    const subs = JSON.parse(await readFile(path, 'utf8')) as Subscription[];
    const expiresAt = new Date(Date.now() + remainingDays * DAY).toISOString();
    for (const s of subs) if (s.userId === 'user-a') s.expiresAt = expiresAt;
    await writeFile(path, JSON.stringify(subs), 'utf8');
  }

  it('gives a free user 0 credit', async () => {
    const b = await fresh();
    await b.effective('user-a'); // materialize the implicit free sub
    const { creditINR, sub } = await b.prorationCredit('user-a');
    expect(creditINR).toBe(0);
    expect(sub?.planId).toBe(FREE_PLAN_ID);
  });

  it('gives a user with no sub record 0 credit', async () => {
    const b = await fresh();
    const { creditINR, sub } = await b.prorationCredit('nobody');
    expect(creditINR).toBe(0);
    expect(sub).toBeNull();
  });

  it('credits ~floor(price*remaining/period) for an active monthly pro halfway through', async () => {
    const b = await fresh();
    const pro = (await b.getPlan('pro'))!; // monthly price 950, periodDays 30
    await b.activateSubscription('user-a', pro, 'monthly');

    const { creditINR } = await b.prorationCredit('user-a');
    // Fresh sub → nearly the full 30 days remain → credit ≈ full price.
    expect(creditINR).toBeGreaterThan(940);
    expect(creditINR).toBeLessThanOrEqual(950);

    // Leave ~15 of 30 days remaining → ~half the price credited.
    await setRemaining(15);
    const b2 = new BillingService(dir);
    await b2.init();
    const half = await b2.prorationCredit('user-a');
    const price = pro.pricing.monthly!.price;
    const remaining = (new Date((await b2.effective('user-a')).subscription.expiresAt!).getTime() - Date.now()) / DAY;
    expect(half.creditINR).toBe(Math.floor((price * Math.min(30, Math.max(0, remaining))) / 30));
    expect(half.creditINR).toBeGreaterThan(450);
    expect(half.creditINR).toBeLessThan(500);
  });

  it('credits 0 for an expired paid sub', async () => {
    const b = await fresh();
    const starter = (await b.getPlan('starter'))!;
    await b.activateSubscription('user-a', starter, 'monthly');
    // Force expiry on disk.
    const path = join(dir, 'subscriptions.json');
    const subs = JSON.parse(await readFile(path, 'utf8')) as Subscription[];
    for (const s of subs) if (s.userId === 'user-a') s.expiresAt = new Date(Date.now() - 1000).toISOString();
    await writeFile(path, JSON.stringify(subs), 'utf8');

    const b2 = new BillingService(dir);
    await b2.init();
    expect((await b2.prorationCredit('user-a')).creditINR).toBe(0);
  });

  it('credits 0 for a lifetime (never-expires) sub', async () => {
    const b = await fresh();
    const lifetime = (await b.getPlan('lifetime'))!;
    await b.activateSubscription('user-a', lifetime, 'lifetime');
    expect((await b.prorationCredit('user-a')).creditINR).toBe(0);
  });

  it('clamps remaining time to 0 when expiresAt is slightly in the past', async () => {
    const b = await fresh();
    const pro = (await b.getPlan('pro'))!;
    await b.activateSubscription('user-a', pro, 'monthly');
    // Nudge expiresAt just barely into the past — remaining clamps to 0, not negative.
    const path = join(dir, 'subscriptions.json');
    const subs = JSON.parse(await readFile(path, 'utf8')) as Subscription[];
    for (const s of subs) if (s.userId === 'user-a') s.expiresAt = new Date(Date.now() - 1).toISOString();
    await writeFile(path, JSON.stringify(subs), 'utf8');

    const b2 = new BillingService(dir);
    await b2.init();
    // A past expiresAt is "expired" → credit 0 (never negative).
    expect((await b2.prorationCredit('user-a')).creditINR).toBe(0);
  });
});
