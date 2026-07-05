import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BillingService, FREE_PLAN_ID, type Subscription } from '../src/billing';

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

describe('plan seeding', () => {
  it('seeds free/starter/pro on first init', async () => {
    const b = await fresh();
    const plans = await b.allPlans();
    expect(plans.map((p) => p.id).sort()).toEqual(['free', 'pro', 'starter']);
    const free = await b.getPlan('free');
    expect(free?.scansPerPeriod).toBe(3);
    expect(free?.psiAllowed).toBe(false);
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
    expect(subscription.status).toBe('active');
  });
});

describe('quota enforcement', () => {
  it('allows exactly scansPerPeriod scans then rejects (402 logic)', async () => {
    const b = await fresh();
    for (let i = 0; i < 3; i++) {
      const r = await b.consumeScan('user-a');
      expect(r.ok).toBe(true);
    }
    const blocked = await b.consumeScan('user-a');
    expect(blocked.ok).toBe(false);
    expect(blocked.reason).toMatch(/upgrade/i);
    expect(blocked.subscription.scansUsed).toBe(3);
  });

  it('tracks usage independently per user', async () => {
    const b = await fresh();
    await b.consumeScan('user-a');
    await b.consumeScan('user-a');
    await b.consumeScan('user-b');
    expect((await b.effective('user-a')).subscription.scansUsed).toBe(2);
    expect((await b.effective('user-b')).subscription.scansUsed).toBe(1);
  });
});

describe('period rollover', () => {
  it('resets free-plan usage once the window has elapsed', async () => {
    const b = await fresh();
    await b.consumeScan('user-a');
    await b.consumeScan('user-a');

    // Rewind this user's periodStart past the 30-day window, on disk.
    const path = join(dir, 'subscriptions.json');
    const subs = JSON.parse(await readFile(path, 'utf8')) as Subscription[];
    const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
    for (const s of subs) if (s.userId === 'user-a') s.periodStart = old;
    await writeFile(path, JSON.stringify(subs), 'utf8');

    const b2 = new BillingService(dir); // fresh load from disk
    await b2.init();
    const eff = await b2.effective('user-a');
    expect(eff.subscription.scansUsed).toBe(0); // rolled over
  });
});

describe('paid activation + expiry', () => {
  it('activates a paid plan and downgrades after expiry', async () => {
    const b = await fresh();
    const pro = (await b.getPlan('pro'))!;
    await b.activateSubscription('user-a', pro, 'ls_order1');
    let eff = await b.effective('user-a');
    expect(eff.plan.id).toBe('pro');
    expect(eff.subscription.cashfreeOrderId).toBe('ls_order1');

    // Force expiry on disk, reload, expect fallback to free.
    const path = join(dir, 'subscriptions.json');
    const subs = JSON.parse(await readFile(path, 'utf8')) as Subscription[];
    for (const s of subs) if (s.userId === 'user-a') s.expiresAt = new Date(Date.now() - 1000).toISOString();
    await writeFile(path, JSON.stringify(subs), 'utf8');

    const b2 = new BillingService(dir);
    await b2.init();
    eff = await b2.effective('user-a');
    expect(eff.plan.id).toBe(FREE_PLAN_ID);
  });
});

describe('order fulfillment idempotency', () => {
  it('fulfills once, then reports already-paid on repeat (webhook + return share this path)', async () => {
    const b = await fresh();
    await b.createOrder({ id: 'ls_o1', userId: 'user-a', planId: 'starter', amountINR: 499 });

    const first = await b.fulfillOrder('ls_o1');
    expect(first).toEqual({ found: true, alreadyPaid: false, activated: true });
    expect((await b.effective('user-a')).plan.id).toBe('starter');

    const second = await b.fulfillOrder('ls_o1');
    expect(second).toEqual({ found: true, alreadyPaid: true, activated: false });

    const missing = await b.fulfillOrder('nope');
    expect(missing.found).toBe(false);
  });

  it('marks the persisted order paid', async () => {
    const b = await fresh();
    await b.createOrder({ id: 'ls_o2', userId: 'user-a', planId: 'pro', amountINR: 1499 });
    await b.fulfillOrder('ls_o2');
    expect((await b.getOrder('ls_o2'))?.status).toBe('paid');
  });
});

describe('admin grant + revoke', () => {
  it('grants a plan for N days and revokes back to free', async () => {
    const b = await fresh();
    const sub = await b.grant('user-a', 'pro', 7);
    expect(sub?.planId).toBe('pro');
    const grantedExpiry = new Date(sub!.expiresAt).getTime() - Date.now();
    expect(grantedExpiry).toBeGreaterThan(6 * 24 * 60 * 60 * 1000);
    expect(grantedExpiry).toBeLessThan(8 * 24 * 60 * 60 * 1000);

    await b.revoke('user-a');
    expect((await b.effective('user-a')).plan.id).toBe(FREE_PLAN_ID);
  });

  it('returns undefined granting an unknown plan', async () => {
    const b = await fresh();
    expect(await b.grant('user-a', 'ghost', 30)).toBeUndefined();
  });
});
