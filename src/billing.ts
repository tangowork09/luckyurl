/**
 * Plans, subscriptions, orders + quota enforcement.
 *
 * Three id-keyed JSON stores in DATA_DIR (plans.json, subscriptions.json,
 * orders.json). Every user has exactly one current subscription record; users
 * who never paid get an implicit "free" one created lazily. Quota + period
 * rollover are resolved on read so an idle process still expires correctly.
 */
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { JsonStore } from './jsonstore';

export interface Plan {
  id: string;
  name: string;
  /** Whole rupees. */
  priceINR: number;
  periodDays: number;
  scansPerPeriod: number;
  maxRadiusMeters: number;
  psiAllowed: boolean;
  maxBusinesses: number;
  active: boolean;
}

export type SubscriptionStatus = 'active' | 'expired';

export interface Subscription {
  id: string;
  userId: string;
  planId: string;
  status: SubscriptionStatus;
  startedAt: string;
  expiresAt: string;
  /** Start of the current usage window; scansUsed resets when it rolls. */
  periodStart: string;
  cashfreeOrderId?: string;
  scansUsed: number;
}

export type OrderStatus = 'pending' | 'paid' | 'failed';

export interface Order {
  id: string; // Cashfree order_id, e.g. "ls_ab12…"
  userId: string;
  planId: string;
  amountINR: number;
  status: OrderStatus;
  createdAt: string;
  paidAt?: string;
  paymentSessionId?: string;
}

export const FREE_PLAN_ID = 'free';

const SEED_PLANS: Plan[] = [
  { id: 'free', name: 'Free', priceINR: 0, periodDays: 30, scansPerPeriod: 3, maxRadiusMeters: 1500, psiAllowed: false, maxBusinesses: 50, active: true },
  { id: 'starter', name: 'Starter', priceINR: 499, periodDays: 30, scansPerPeriod: 25, maxRadiusMeters: 3000, psiAllowed: true, maxBusinesses: 300, active: true },
  { id: 'pro', name: 'Pro', priceINR: 1499, periodDays: 30, scansPerPeriod: 100, maxRadiusMeters: 6000, psiAllowed: true, maxBusinesses: 1000, active: true },
];

const DAY_MS = 24 * 60 * 60 * 1000;
const hex = (n: number) => randomBytes(n).toString('hex');

export interface EffectivePlan {
  plan: Plan;
  subscription: Subscription;
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
    }
  }

  /* -------------------------------- plans ------------------------------- */

  async allPlans(): Promise<Plan[]> {
    await this.plans.load();
    return this.plans.all();
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

  private async freeSubFor(userId: string, existingId?: string): Promise<Subscription> {
    const free = await this.freePlan();
    const now = new Date();
    const sub: Subscription = {
      id: existingId ?? hex(12),
      userId,
      planId: FREE_PLAN_ID,
      status: 'active',
      startedAt: now.toISOString(),
      periodStart: now.toISOString(),
      expiresAt: new Date(now.getTime() + free.periodDays * DAY_MS).toISOString(),
      scansUsed: 0,
    };
    return this.subs.put(sub);
  }

  /**
   * Resolve a user's effective plan, applying expiry + period rollover as a
   * side effect (persisted). Users with no record get an implicit free plan.
   */
  async effective(userId: string): Promise<EffectivePlan> {
    let sub = await this.rawSub(userId);
    if (!sub) sub = await this.freeSubFor(userId);

    const now = Date.now();

    // Paid plan past expiry → downgrade to a fresh free window.
    if (sub.planId !== FREE_PLAN_ID && new Date(sub.expiresAt).getTime() < now) {
      sub = await this.freeSubFor(userId, sub.id);
    }

    // Free plan: rolling reset of the usage window.
    if (sub.planId === FREE_PLAN_ID) {
      const free = await this.freePlan();
      if (new Date(sub.periodStart).getTime() + free.periodDays * DAY_MS <= now) {
        sub = await this.subs.put({
          ...sub,
          status: 'active',
          periodStart: new Date(now).toISOString(),
          expiresAt: new Date(now + free.periodDays * DAY_MS).toISOString(),
          scansUsed: 0,
        });
      }
    }

    const plan = (await this.getPlan(sub.planId)) ?? (await this.freePlan());
    return { plan, subscription: sub };
  }

  /** Check quota and, if allowed, increment scansUsed atomically-ish. */
  async consumeScan(userId: string): Promise<ScanConsumeResult> {
    const { plan, subscription } = await this.effective(userId);
    if (subscription.scansUsed >= plan.scansPerPeriod) {
      return {
        ok: false,
        plan,
        subscription,
        reason: `You've used all ${plan.scansPerPeriod} scans on the ${plan.name} plan for this period. Upgrade for more.`,
      };
    }
    const updated = await this.subs.put({ ...subscription, scansUsed: subscription.scansUsed + 1 });
    return { ok: true, plan, subscription: updated };
  }

  /** Activate a paid subscription for a user (idempotent path shared by webhook + return verify). */
  async activateSubscription(userId: string, plan: Plan, cashfreeOrderId?: string): Promise<Subscription> {
    const existing = await this.rawSub(userId);
    const now = new Date();
    const sub: Subscription = {
      id: existing?.id ?? hex(12),
      userId,
      planId: plan.id,
      status: 'active',
      startedAt: now.toISOString(),
      periodStart: now.toISOString(),
      expiresAt: new Date(now.getTime() + plan.periodDays * DAY_MS).toISOString(),
      cashfreeOrderId,
      scansUsed: 0,
    };
    return this.subs.put(sub);
  }

  /** Admin manual grant: activate a plan for N days. */
  async grant(userId: string, planId: string, days: number): Promise<Subscription | undefined> {
    const plan = await this.getPlan(planId);
    if (!plan) return undefined;
    const existing = await this.rawSub(userId);
    const now = new Date();
    const period = Number.isFinite(days) && days > 0 ? days : plan.periodDays;
    const sub: Subscription = {
      id: existing?.id ?? hex(12),
      userId,
      planId: plan.id,
      status: 'active',
      startedAt: now.toISOString(),
      periodStart: now.toISOString(),
      expiresAt: new Date(now.getTime() + period * DAY_MS).toISOString(),
      scansUsed: 0,
    };
    return this.subs.put(sub);
  }

  async revoke(userId: string): Promise<Subscription> {
    const existing = await this.rawSub(userId);
    return this.freeSubFor(userId, existing?.id);
  }

  /* -------------------------------- orders ------------------------------ */

  async createOrder(input: { id: string; userId: string; planId: string; amountINR: number; paymentSessionId?: string }): Promise<Order> {
    const order: Order = {
      id: input.id,
      userId: input.userId,
      planId: input.planId,
      amountINR: input.amountINR,
      status: 'pending',
      createdAt: new Date().toISOString(),
      paymentSessionId: input.paymentSessionId,
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
   * Idempotently mark an order paid and activate its subscription. Returns
   * { activated } false when the order was already paid (safe to call twice
   * from both the webhook and the return-page verify).
   */
  async fulfillOrder(orderId: string): Promise<{ found: boolean; alreadyPaid: boolean; activated: boolean }> {
    const order = await this.getOrder(orderId);
    if (!order) return { found: false, alreadyPaid: false, activated: false };
    if (order.status === 'paid') return { found: true, alreadyPaid: true, activated: false };
    const plan = await this.getPlan(order.planId);
    if (!plan) return { found: true, alreadyPaid: false, activated: false };
    await this.activateSubscription(order.userId, plan, order.id);
    await this.orders.put({ ...order, status: 'paid', paidAt: new Date().toISOString() });
    return { found: true, alreadyPaid: false, activated: true };
  }

  async markOrderFailed(orderId: string): Promise<void> {
    const order = await this.getOrder(orderId);
    if (order && order.status === 'pending') await this.orders.put({ ...order, status: 'failed' });
  }
}
