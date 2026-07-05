import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cashfreeBaseUrl } from './cashfree';
import { DEFAULT_WEIGHTS } from './score';
import type { AppConfig, ScoringWeights } from './types';

const DEFAULT_APIFY_ACTOR = 'compass/crawler-google-places';

/**
 * Minimal .env parser: KEY=VALUE lines, '#' comments, surrounding quotes
 * stripped. No escapes/interpolation — this is deliberately tiny (no dotenv).
 */
function parseEnvFile(content: string): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    if (key !== '') vars[key] = value;
  }
  return vars;
}

function readDotEnv(): Record<string, string> {
  try {
    return parseEnvFile(readFileSync(resolve(process.cwd(), '.env'), 'utf8'));
  } catch {
    return {}; // no .env is a normal case (demo mode / env-only config)
  }
}

export function loadConfig(): AppConfig {
  const fileVars = readDotEnv();

  // process.env wins over .env; empty strings count as unset.
  const get = (key: string): string | undefined => {
    const value = process.env[key] ?? fileVars[key];
    return value === undefined || value.trim() === '' ? undefined : value.trim();
  };

  const googleApiKey = get('GOOGLE_MAPS_API_KEY');
  const pagespeedKey = get('PAGESPEED_API_KEY');
  const apifyToken = get('APIFY_TOKEN');
  const apifyActorId = get('APIFY_ACTOR_ID') ?? DEFAULT_APIFY_ACTOR;
  const parsedPort = Number(get('PORT'));
  const port = Number.isInteger(parsedPort) && parsedPort > 0 ? parsedPort : 4600;

  // Precedence: Google key > Apify token > DEMO env > free OSM.
  const demoEnv = get('DEMO');
  const dataSource: AppConfig['dataSource'] = googleApiKey
    ? 'google'
    : apifyToken
      ? 'apify'
      : demoEnv && demoEnv !== '0' && demoEnv.toLowerCase() !== 'false'
        ? 'demo'
        : 'osm';

  // ---- Auth + billing ----
  const isProd = (get('NODE_ENV') ?? '').toLowerCase() === 'production';
  const appBaseUrl = get('APP_BASE_URL') ?? `http://localhost:${port}`;
  const secureCookies = appBaseUrl.startsWith('https://');

  const sessionSecret = resolveSessionSecret(get('SESSION_SECRET'), isProd);

  const cashfreeEnv: AppConfig['cashfreeEnv'] = get('CASHFREE_ENV') === 'production' ? 'production' : 'sandbox';
  const cashfreeSecretKey = get('CASHFREE_SECRET_KEY');

  return {
    googleApiKey,
    pagespeedKey,
    apifyToken,
    apifyActorId,
    dataSource,
    demoMode: dataSource === 'demo',
    weights: loadWeights(get('SCORING_WEIGHTS')),
    port,
    sessionSecret,
    secureCookies,
    appBaseUrl,
    dataDir: resolve(process.cwd(), get('DATA_DIR') ?? './data'),
    adminEmail: (get('ADMIN_EMAIL') ?? 'admin@leadscout.local').toLowerCase(),
    adminPassword: get('ADMIN_PASSWORD'),
    cashfreeAppId: get('CASHFREE_APP_ID'),
    cashfreeSecretKey,
    cashfreeEnv,
    // Cashfree signs webhooks with the secret key, so default to it.
    cashfreeWebhookSecret: get('CASHFREE_WEBHOOK_SECRET') ?? cashfreeSecretKey,
    cashfreeBaseUrl: cashfreeBaseUrl(cashfreeEnv),
  };
}

/**
 * SESSION_SECRET is required in production. In dev we fall back to a random
 * per-boot secret (with a warning) — that logs everyone out on restart, which
 * is fine for local development but never for a real deployment.
 */
function resolveSessionSecret(fromEnv: string | undefined, isProd: boolean): string {
  if (fromEnv) return fromEnv;
  if (isProd) {
    throw new Error('SESSION_SECRET is required in production (NODE_ENV=production). Set a long random value.');
  }
  console.warn('SESSION_SECRET not set — using a random per-boot secret (dev only; sessions drop on restart).');
  return randomBytes(32).toString('hex');
}

/** Deep-merge a JSON `.env` override onto DEFAULT_WEIGHTS; bad JSON is ignored. */
function loadWeights(raw: string | undefined): ScoringWeights {
  if (!raw) return DEFAULT_WEIGHTS;
  try {
    const override = JSON.parse(raw) as Partial<ScoringWeights>;
    return {
      ...DEFAULT_WEIGHTS,
      ...override,
      severity: { ...DEFAULT_WEIGHTS.severity, ...override.severity },
      base: { ...DEFAULT_WEIGHTS.base, ...override.base },
    };
  } catch {
    console.warn('SCORING_WEIGHTS is not valid JSON — using defaults.');
    return DEFAULT_WEIGHTS;
  }
}
