/**
 * Plans, subscriptions, orders + quota enforcement.
 *
 * Three id-keyed JSON stores in DATA_DIR (plans.json, subscriptions.json,
 * orders.json). Every user has exactly one current subscription record; users
 * who never paid get an implicit "free" one created lazily. Quota + period
 * rollover are resolved on read so an idle process still expires correctly.
 *
 * Pricing model (4 tiers, whole rupees):
 *   free     — 2 LIFETIME scans (not per-period), no pricing (implicit)
 *   starter  — monthly / yearly cycles
 *   pro      — monthly / yearly cycles (highlighted)
 *   lifetime — one-time purchase, never expires (best value)
 *
 * Billing cycles carry their own periodDays: monthly=30, yearly=365,
 * lifetime=null (never expires). A null expiresAt is treated as "never expired"
 * everywhere expiry is checked.
 */
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { JsonStore } from './jsonstore';

export type BillingCycle = 'monthly' | 'yearly' | 'lifetime';
export type AiFeatureLevel = 'none' | 'basic' | 'full';

export const BILLING_CYCLES: BillingCycle[] = ['monthly', 'yearly', 'lifetime'];

/** periodDays per cycle; null means "never expires" (lifetime). */
export const CYCLE_PERIOD_DAYS: Record<BillingCycle, number | null> = {
  monthly: 30,
  yearly: 365,
  lifetime: null,
};

export interface CyclePricing {
  /** Whole rupees actually charged. */
  price: number;
  /** Whole rupees "MRP" shown struck-through. */
  mrp: number;
  /** 30 (monthly), 365 (yearly), or null (lifetime — never expires). */
  periodDays: number | null;
}

export interface Plan {
  id: string;
  name: string;
  /** Rank: free=0, starter=1, pro=2, lifetime=3. */
  tier: number;
  /** Scans allowed per paid period. Free treats this as a LIFETIME allotment. */
  scansPerPeriod: number;
  maxRadiusMeters: number;
  maxBusinesses: number;
  psiAllowed: boolean;
  aiFeatures: AiFeatureLevel;
  prioritySupport: boolean;
  /**
   * Scan-history retention window in days: how far back the past-scans list may
   * reach. 0 = locked (free). free=0, starter=2, pro=30, lifetime=3650 ("full").
   * Older scan dirs are hidden from the list, never deleted (see retention.ts).
   */
  historyDays: number;
  /** Which cycles the plan offers, with per-cycle prices. Empty for free. */
  pricing: Partial<Record<BillingCycle, CyclePricing>>;
  badge?: 'popular' | 'best-value';
  active: boolean;
}

export type SubscriptionStatus = 'active' | 'expired';

export interface Subscription {
  id: string;
  userId: string;
  planId: string;
  /** Billing cycle of the current paid sub (absent for free). */
  cycle?: BillingCycle;
  status: SubscriptionStatus;
  startedAt: string;
  /** ISO date, or null for lifetime / never-expires. */
  expiresAt: string | null;
  /** Start of the current paid usage window; scansUsed resets when it rolls. */
  periodStart: string;
  cashfreeOrderId?: string;
  /** Scans used in the current PAID period (reset on each activation/rollover). */
  scansUsed: number;
  /** Lifetime count of scans consumed while on the free tier. NEVER reset. */
  freeScansUsed: number;
}

export type OrderStatus = 'pending' | 'paid' | 'failed';

export interface Order {
  id: string; // Cashfree order_id, e.g. "ls_ab12…"
  userId: string;
  planId: string;
  cycle: BillingCycle;
  amountINR: number;
  status: OrderStatus;
  createdAt: string;
  paidAt?: string;
  paymentSessionId?: string;
  /** Prorated rupee credit deducted from this order's amount (in-cycle switch). */
  creditApplied?: number;
}

export const FREE_PLAN_ID = 'free';
/** Free tier is a one-time lifetime allotment of this many scans. */
export const FREE_LIFETIME_SCANS = 2;
/** scansPerPeriod at or above this is surfaced as "unlimited" (lifetime tier). */
export const UNLIMITED_SCANS = 100000;

/**
 * Virtual plan used to bypass ALL plan gating for the admin role. Never
 * persisted to the plans store — resolved in-memory whenever role==='admin',
 * so it never appears in allPlans()/activePlans() and is never buyable.
 * Everything is maxed out: unlimited scans, top tier, full AI, full history.
 */
export const ADMIN_PLAN: Plan = {
  id: 'admin',
  name: 'Admin',
  tier: 3,
  scansPerPeriod: UNLIMITED_SCANS,
  maxRadiusMeters: 50000,
  maxBusinesses: 2000,
  psiAllowed: true,
  aiFeatures: 'full',
  prioritySupport: true,
  historyDays: 3650,
  pricing: {},
  active: true,
};

const SEED_PLANS: Plan[] = [
  {
    id: 'free',
    name: 'Free',
    tier: 0,
    scansPerPeriod: FREE_LIFETIME_SCANS,
    maxRadiusMeters: 1500,
    maxBusinesses: 50,
    psiAllowed: false,
    aiFeatures: 'none',
    prioritySupport: false,
    historyDays: 0,
    pricing: {},
    active: true,
  },
  {
    id: 'starter',
    name: 'Starter',
    tier: 1,
    scansPerPeriod: 25,
    maxRadiusMeters: 3000,
    maxBusinesses: 300,
    psiAllowed: true,
    aiFeatures: 'basic',
    prioritySupport: false,
    historyDays: 2,
    pricing: {
      monthly: { price: 450, mrp: 900, periodDays: 30 },
      yearly: { price: 4500, mrp: 10800, periodDays: 365 },
    },
    active: true,
  },
  {
    id: 'pro',
    name: 'Pro',
    tier: 2,
    scansPerPeriod: 100,
    maxRadiusMeters: 6000,
    maxBusinesses: 1000,
    psiAllowed: true,
    aiFeatures: 'full',
    prioritySupport: false,
    historyDays: 30,
    pricing: {
      monthly: { price: 950, mrp: 3000, periodDays: 30 },
      yearly: { price: 9500, mrp: 36000, periodDays: 365 },
    },
    badge: 'popular',
    active: true,
  },
  {
    id: 'lifetime',
    name: 'Lifetime',
    tier: 3,
    scansPerPeriod: UNLIMITED_SCANS,
    maxRadiusMeters: 6000,
    maxBusinesses: 1000,
    psiAllowed: true,
    aiFeatures: 'full',
    prioritySupport: true,
    historyDays: 3650,
    pricing: {
      lifetime: { price: 15000, mrp: 43000, periodDays: null },
    },
    badge: 'best-value',
    active: true,
  },
];

const DAY_MS = 24 * 60 * 60 * 1000;
const hex = (n: number) => randomBytes(n).toString('hex');

/** A null expiresAt (lifetime) is never expired. */
function isExpired(expiresAt: string | null, now: number): boolean {
  if (expiresAt == null) return false;
  return new Date(expiresAt).getTime() < now;
}

export interface EffectivePlan {
  plan: Plan;
  subscription: Subscription;
}

export interface UsageView {
  /** true for the lifetime tier — quota is effectively unlimited. */
  unlimited: boolean;
  /** Scans consumed that count against the active plan's quota. */
  scansUsed: number;
  /** Remaining scans, or null when unlimited. */
  scansRemaining: number | null;
}

/** Resolve the usage numbers that matter for the plan a sub is currently on. */
export function usageFor(plan: Plan, sub: Subscription): UsageView {
  const isFree = plan.id === FREE_PLAN_ID;
  const used = isFree ? sub.freeScansUsed : sub.scansUsed;
  const unlimited = plan.scansPerPeriod >= UNLIMITED_SCANS;
  return {
    unlimited,
    scansUsed: used,
    scansRemaining: unlimited ? null : Math.max(0, plan.scansPerPeriod - used),
  };
}

export interface ScanConsumeResult {
  ok: boolean;
  plan: Plan;
  subscription: Subscription;
  /** Present when ok === false. */
  reason?: string;
}

export class BillingService {
  private plans: JsonStore<Plan>;
  private subs: JsonStore<Subscription>;
  private orders: JsonStore<Order>;
  /** Per-user serialization for consumeScan's read-modify-write (see below). */
  private consumeChain = new Map<string, Promise<unknown>>();

  constructor(dataDir: string) {
    this.plans = new JsonStore<Plan>(join(dataDir, 'plans.json'));
    this.subs = new JsonStore<Subscription>(join(dataDir, 'subscriptions.json'));
    this.orders = new JsonStore<Order>(join(dataDir, 'orders.json'));
  }

  /** Seed the default plans on first boot (only if plans.json is empty). */
  async init(): Promise<void> {
    await this.plans.load();
    if (this.plans.all().length === 0) {
      for (const p of SEED_PLANS) await this.plans.put(p);
      return;
    }
    // Migrate default plans persisted under an older schema (no `pricing` map /
    // no lifetime tier). A stored default plan that already has `pricing` was
    // saved under the current schema (possibly admin-edited) and is left alone.
    for (const seed of SEED_PLANS) {
      const existing = this.plans.get(seed.id);
      if (!existing || !existing.pricing) await this.plans.put(seed);
    }
  }

  /* -------------------------------- plans ------------------------------- */

  async allPlans(): Promise<Plan[]> {
    await this.plans.load();
    return this.plans.all().sort((a, b) => a.tier - b.tier);
  }

  async activePlans(): Promise<Plan[]> {
    return (await this.allPlans()).filter((p) => p.active);
  }

  async getPlan(id: string): Promise<Plan | undefined> {
    await this.plans.load();
    return this.plans.get(id);
  }

  async freePlan(): Promise<Plan> {
    return (await this.getPlan(FREE_PLAN_ID)) ?? SEED_PLANS[0];
  }

  async upsertPlan(plan: Plan): Promise<Plan> {
    return this.plans.put(plan);
  }

  /* ---------------------------- subscriptions --------------------------- */

  private async rawSub(userId: string): Promise<Subscription | undefined> {
    await this.subs.load();
    return this.subs.find((s) => s.userId === userId);
  }

  /**
   * Create/replace a free subscription. `freeScansUsed` is a lifetime counter
   * that must be carried across downgrades — the free 2 scans do NOT reset.
   */
  private async freeSubFor(userId: string, existingId?: string, freeScansUsed = 0): Promise<Subscription> {
    const now = new Date();
    const sub: Subscription = {
      id: existingId ?? hex(12),
      userId,
      planId: FREE_PLAN_ID,
      status: 'active',
      startedAt: now.toISOString(),
      periodStart: now.toISOString(),
      expiresAt: null, // free never "expires" in the paid sense
      scansUsed: 0,
      freeScansUsed,
    };
    return this.subs.put(sub);
  }

  /**
   * Resolve a user's effective plan, applying paid-plan expiry as a side effect
   * (persisted). Users with no record get an implicit free plan. Free scans are
   * a lifetime allotment, so there is no free-plan rollover.
   */
  async effective(userId: string): Promise<EffectivePlan> {
    let sub = await this.rawSub(userId);
    if (!sub) sub = await this.freeSubFor(userId);

    const now = Date.now();

    // Paid plan past expiry → downgrade to free, preserving lifetime free usage.
    // A null expiresAt (lifetime purchase) never expires.
    if (sub.planId !== FREE_PLAN_ID && isExpired(sub.expiresAt, now)) {
      sub = await this.freeSubFor(userId, sub.id, sub.freeScansUsed);
    }

    const plan = (await this.getPlan(sub.planId)) ?? (await this.freePlan());
    return { plan, subscription: sub };
  }

  /**
   * Check quota and, if allowed, increment the right counter — ATOMICALLY per
   * user. The load→check→write below must not interleave across concurrent
   * callers (two /api/scan requests could otherwise both read the same stale
   * count and both pass). We serialize per-user by chaining onto that user's
   * previous consume, so exactly one call can win the last scan.
   */
  async consumeScan(userId: string): Promise<ScanConsumeResult> {
    const prev = this.consumeChain.get(userId) ?? Promise.resolve();
    const run = prev.catch(() => {}).then(() => this.doConsumeScan(userId));
    // Keep the chain alive past a rejection so future calls still serialize.
    this.consumeChain.set(userId, run.catch(() => {}));
    return run;
  }

  private async doConsumeScan(userId: string): Promise<ScanConsumeResult> {
    const { plan, subscription } = await this.effective(userId);
    const isFree = plan.id === FREE_PLAN_ID;
    const used = isFree ? subscription.freeScansUsed : subscription.scansUsed;

    if (used >= plan.scansPerPeriod) {
      const reason = isFree
        ? `You've used your ${plan.scansPerPeriod} free scans. Upgrade to a paid plan to keep scanning.`
        : `You've used all ${plan.scansPerPeriod} scans on the ${plan.name} plan for this period. Upgrade for more.`;
      return { ok: false, plan, subscription, reason };
    }

    const updated = isFree
      ? await this.subs.put({ ...subscription, freeScansUsed: subscription.freeScansUsed + 1 })
      : await this.subs.put({ ...subscription, scansUsed: subscription.scansUsed + 1 });
    return { ok: true, plan, subscription: updated };
  }

  /**
   * Activate a paid subscription for a user on a given cycle (idempotent path
   * shared by webhook + return verify). expiresAt is set from the cycle's
   * periodDays (null → never expires). scansUsed resets for the new period;
   * the lifetime free counter is preserved.
   */
  async activateSubscription(
    userId: string,
    plan: Plan,
    cycle: BillingCycle,
    cashfreeOrderId?: string,
  ): Promise<Subscription> {
    const existing = await this.rawSub(userId);
    const now = new Date();
    const periodDays = plan.pricing[cycle]?.periodDays ?? CYCLE_PERIOD_DAYS[cycle];
    const expiresAt = periodDays == null ? null : new Date(now.getTime() + periodDays * DAY_MS).toISOString();
    const sub: Subscription = {
      id: existing?.id ?? hex(12),
      userId,
      planId: plan.id,
      cycle,
      status: 'active',
      startedAt: now.toISOString(),
      periodStart: now.toISOString(),
      expiresAt,
      cashfreeOrderId,
      scansUsed: 0,
      freeScansUsed: existing?.freeScansUsed ?? 0,
    };
    return this.subs.put(sub);
  }

  /** Admin manual grant: activate a plan for N days (lifetime tier → never expires). */
  async grant(userId: string, planId: string, days: number): Promise<Subscription | undefined> {
    const plan = await this.getPlan(planId);
    if (!plan) return undefined;
    const existing = await this.rawSub(userId);
    const now = new Date();
    const offersLifetimeOnly = !!plan.pricing.lifetime && !plan.pricing.monthly && !plan.pricing.yearly;
    const lifetime = plan.tier >= 3 || offersLifetimeOnly;
    const period = Number.isFinite(days) && days > 0 ? days : 30;
    const cycle: BillingCycle = lifetime ? 'lifetime' : period >= 180 ? 'yearly' : 'monthly';
    const sub: Subscription = {
      id: existing?.id ?? hex(12),
      userId,
      planId: plan.id,
      cycle,
      status: 'active',
      startedAt: now.toISOString(),
      periodStart: now.toISOString(),
      expiresAt: lifetime ? null : new Date(now.getTime() + period * DAY_MS).toISOString(),
      scansUsed: 0,
      freeScansUsed: existing?.freeScansUsed ?? 0,
    };
    return this.subs.put(sub);
  }

  async revoke(userId: string): Promise<Subscription> {
    const existing = await this.rawSub(userId);
    return this.freeSubFor(userId, existing?.id, existing?.freeScansUsed ?? 0);
  }

  /**
   * Prorated rupee credit for the UNUSED time left on a user's current paid sub,
   * used to discount an in-cycle upgrade/switch. Credit is 0 unless the user is
   * on a live (non-expired) paid monthly/yearly sub whose plan still prices that
   * cycle — free, expired, and lifetime (null expiresAt) subs earn nothing. The
   * remaining-days ratio is clamped to [0, periodDays] so a slightly-past expiry
   * or a clock skew can't produce a negative or over-full credit.
   */
  async prorationCredit(userId: string): Promise<{ creditINR: number; sub: Subscription | null }> {
    const sub = (await this.rawSub(userId)) ?? null;
    const now = Date.now();
    if (
      !sub ||
      sub.expiresAt == null ||
      isExpired(sub.expiresAt, now) ||
      (sub.cycle !== 'monthly' && sub.cycle !== 'yearly')
    ) {
      return { creditINR: 0, sub };
    }
    const plan = await this.getPlan(sub.planId);
    if (!plan || plan.tier <= 0) return { creditINR: 0, sub };
    const pricing = plan.pricing[sub.cycle];
    if (!pricing) return { creditINR: 0, sub };
    const periodDays = pricing.periodDays ?? CYCLE_PERIOD_DAYS[sub.cycle];
    if (periodDays == null || periodDays <= 0) return { creditINR: 0, sub };
    const remainingDays = Math.min(periodDays, Math.max(0, (new Date(sub.expiresAt).getTime() - now) / DAY_MS));
    const creditINR = Math.floor((pricing.price * remainingDays) / periodDays);
    return { creditINR, sub };
  }

  /* -------------------------------- orders ------------------------------ */

  async createOrder(input: {
    id: string;
    userId: string;
    planId: string;
    cycle: BillingCycle;
    amountINR: number;
    creditApplied?: number;
    paymentSessionId?: string;
  }): Promise<Order> {
    const order: Order = {
      id: input.id,
      userId: input.userId,
      planId: input.planId,
      cycle: input.cycle,
      amountINR: input.amountINR,
      status: 'pending',
      createdAt: new Date().toISOString(),
      paymentSessionId: input.paymentSessionId,
      creditApplied: input.creditApplied,
    };
    return this.orders.put(order);
  }

  async getOrder(id: string): Promise<Order | undefined> {
    await this.orders.load();
    return this.orders.get(id);
  }

  async allOrders(): Promise<Order[]> {
    await this.orders.load();
    return this.orders.all();
  }

  /**
   * Idempotently mark an order paid and activate its subscription on the order's
   * cycle. Returns { activated } false when the order was already paid (safe to
   * call twice from both the webhook and the return-page verify).
   */
  async fulfillOrder(orderId: string): Promise<{ found: boolean; alreadyPaid: boolean; activated: boolean }> {
    const order = await this.getOrder(orderId);
    if (!order) return { found: false, alreadyPaid: false, activated: false };
    if (order.status === 'paid') return { found: true, alreadyPaid: true, activated: false };
    const plan = await this.getPlan(order.planId);
    if (!plan) return { found: true, alreadyPaid: false, activated: false };
    await this.activateSubscription(order.userId, plan, order.cycle, order.id);
    await this.orders.put({ ...order, status: 'paid', paidAt: new Date().toISOString() });
    return { found: true, alreadyPaid: false, activated: true };
  }

  async markOrderFailed(orderId: string): Promise<void> {
    const order = await this.getOrder(orderId);
    if (order && order.status === 'pending') await this.orders.put({ ...order, status: 'failed' });
  }
}
