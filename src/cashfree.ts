/**
 * Cashfree Payment Gateway client (API version 2023-08-01).
 *
 * One-time orders per plan period (not recurring mandates). We create an order,
 * hand the payment_session_id to the browser SDK, then confirm payment either
 * via the webhook or by polling GET /orders/{id} from the return page.
 *
 * Webhook auth: signature = base64(HMAC-SHA256(timestamp + rawBody, secret)),
 * compared constant-time to the x-webhook-signature header.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const CASHFREE_API_VERSION = '2023-08-01';

export function cashfreeBaseUrl(env: 'sandbox' | 'production'): string {
  return env === 'production' ? 'https://api.cashfree.com/pg' : 'https://sandbox.cashfree.com/pg';
}

export interface CashfreeClientConfig {
  appId: string;
  secretKey: string;
  baseUrl: string;
}

export function newOrderId(): string {
  return `ls_${randomBytes(12).toString('hex')}`;
}

interface CreateOrderInput {
  orderId: string;
  amountINR: number;
  customerId: string;
  customerEmail: string;
  customerPhone: string;
  returnUrl: string;
  note: string;
}

export interface CashfreeOrderResponse {
  order_id: string;
  order_status: string;
  payment_session_id: string;
  [k: string]: unknown;
}

function headers(cfg: CashfreeClientConfig): Record<string, string> {
  return {
    'x-client-id': cfg.appId,
    'x-client-secret': cfg.secretKey,
    'x-api-version': CASHFREE_API_VERSION,
    'Content-Type': 'application/json',
  };
}

export async function createOrder(cfg: CashfreeClientConfig, input: CreateOrderInput): Promise<CashfreeOrderResponse> {
  const body = {
    order_id: input.orderId,
    order_amount: input.amountINR,
    order_currency: 'INR',
    customer_details: {
      customer_id: input.customerId,
      customer_email: input.customerEmail,
      customer_phone: input.customerPhone,
    },
    order_meta: { return_url: input.returnUrl },
    order_note: input.note,
  };
  const res = await fetch(`${cfg.baseUrl}/orders`, {
    method: 'POST',
    headers: headers(cfg),
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const message = typeof json.message === 'string' ? json.message : `Cashfree order failed (HTTP ${res.status}).`;
    throw new Error(message);
  }
  return json as CashfreeOrderResponse;
}

export async function fetchOrder(cfg: CashfreeClientConfig, orderId: string): Promise<CashfreeOrderResponse> {
  const res = await fetch(`${cfg.baseUrl}/orders/${encodeURIComponent(orderId)}`, {
    method: 'GET',
    headers: headers(cfg),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const message = typeof json.message === 'string' ? json.message : `Cashfree order lookup failed (HTTP ${res.status}).`;
    throw new Error(message);
  }
  return json as CashfreeOrderResponse;
}

/**
 * Verify a Cashfree webhook. Pass the EXACT raw request body (string), the
 * x-webhook-timestamp and x-webhook-signature headers, and the webhook secret.
 */
export function verifyWebhookSignature(
  timestamp: string,
  rawBody: string,
  signature: string,
  secret: string,
): boolean {
  if (!timestamp || !signature) return false;
  const expected = createHmac('sha256', secret).update(timestamp + rawBody).digest('base64');
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
