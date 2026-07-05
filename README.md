# LeadScout

Pick an area on a map. LeadScout finds every registered business there,
splits them into:

- **No website** — a business listing but no site at all (or only a
  Facebook/Instagram/WhatsApp/Linktree link),
- **Broken website** — a site that's down, erroring, or unreachable,
- **Needs improvement** — a live site failing basics (not mobile-friendly, no
  HTTPS, mixed content, missing titles/meta, broken links/forms, stale copyright,
  ancient builder, slow / poor Core Web Vitals, no contact method),

scores each as a lead (popularity × category value × competitor density × how
bad the gap is), estimates a ₹ project value and how winnable it is, then for
**each lead** writes a pitch-ready brief **plus a mock landing page, a printable
audit one-pager, ready-to-send WhatsApp/email/SMS drafts, and a paste-into-Claude
pitch prompt**. A CRM store remembers status across scans so you never re-pitch a
business you already won.

## Data sources (pick your cost/quality)

LeadScout auto-selects a source by which credentials are present, in this order:

| Source | Cost | Card? | Set in `.env` | Data |
| ------ | ---- | ----- | ------------- | ---- |
| **Google Places (New)** | free ≤5k/mo | yes | `GOOGLE_MAPS_API_KEY` | full: ratings, reviews, types |
| **Apify** (paid scraper) | ~$1.50/1k | yes | `APIFY_TOKEN` | full: ratings, reviews, emails |
| **OpenStreetMap** (default) | **free** | **no** | *(nothing)* | good in metros; no ratings |
| **demo** | free | no | `DEMO=1` or `--demo` | deterministic fake data |

With no keys at all you get the free **OpenStreetMap** path — no card, no ToS
risk. It has thinner coverage of tiny shops and no review counts (LeadScout
substitutes an "establishment maturity" proxy from OSM tag richness).

## Quick start

```bash
npm install

# Free — OpenStreetMap, no key, no card:
npm run dev            # http://localhost:4600
npm run scan -- --lat 12.9719 --lng 77.6412 --radius 1000 --categories food

# Demo mode — deterministic fake data:
npm run scan -- --demo
```

## Real data setup

**Google (recommended, free tier):**
1. [Google Cloud Console](https://console.cloud.google.com/) → new project →
   enable **Places API (New)** → create an API key. Billing must be enabled.
2. Restrict the key to Places API (New) only.
3. `cp .env.example .env` and set `GOOGLE_MAPS_API_KEY=...`.

**Apify (no Google billing card):** set `APIFY_TOKEN=...` (and optionally
`APIFY_ACTOR_ID`, default `compass/crawler-google-places`). Costs your Apify
credits per run; the scraping ToS/liability sits with your Apify account.

### Cost

LeadScout uses Nearby Search (New) — a **Pro SKU** call. Google's free tier
gives thousands of Pro calls/month free (5,000/mo as of 2025; check current
pricing). Calls per scan = grid cells × category groups selected:

| Radius | Cells | 8 groups | 3 groups |
| ------ | ----- | -------- | -------- |
| 800 m  | 1     | 8 calls  | 3 calls  |
| 2 km   | ~9    | ~72      | ~27      |
| 5 km   | ~48   | ~384     | ~144     |

Website audits are plain HTTP fetches — free. Optional PageSpeed Insights
audits (`--psi`) are free but slow (~30s per site).

> Note: Google's Places ToS restricts long-term storage/republication of
> Places content. Keep generated lead files as short-term working data for
> your own outreach, not as a redistributable database.

## CLI

```bash
npm run scan -- --lat 12.9758 --lng 77.6045 --radius 2000 \
  --categories food,retail,beauty --max 300 --out ./leads
```

| Flag | Meaning | Default |
| ---- | ------- | ------- |
| `--lat --lng` | Area center | required (except `--demo`) |
| `--radius` | Meters, 100–50000 | 2000 |
| `--categories` | Comma list of group keys (`food,retail,health,beauty,fitness,professional,home,auto`) | all |
| `--max` | Cap on businesses | 300 |
| `--psi` | PageSpeed Insights + accessibility/CWV + mobile screenshot + link/form checks | off |
| `--pack N` | Also bundle the top N leads into `pack/<slug>/` folders | off |
| `--draft` | Auto-draft each top lead's pitch via the local `ensemble` CLI | off |
| `--out` | Output root | `./leads` |
| `--demo` | Force demo mode | off |

## Web UI

`npm run dev` → search or click the map to set center, drag the radius slider,
tick categories, **Scan** (with a **Cancel** button for long runs). Live progress
streams in. The results panel lets you **filter by kind and minimum score**, set
each lead's **pipeline status** (new → contacted → won…), **copy its Claude
prompt** to the clipboard, and open its **preview / audit / brief**. A **Past
scans** panel reloads any earlier scan from disk with no API calls. Links to the
visual **Gallery**, `SUMMARY.md`, `leads.json` and a **pipeline CSV** sit above
the list.

## Going live (hosting, accounts & billing)

LeadScout ships as a single always-on Node process with **file-based JSON
stores** on a persistent disk — no external database. In hosted mode it is
**multi-tenant**: every user signs in, gets their own lead directory
(`leads/<userId>/…`), their own CRM store, and a plan that caps
scans-per-period, radius, businesses and PageSpeed audits.

**Accounts.** Hand-rolled auth (scrypt password hashing + an HMAC-signed
`ls_session` cookie). The first admin is seeded on boot from `ADMIN_EMAIL` +
`ADMIN_PASSWORD`. Sign-in/up is at `/login.html`; admins get `/admin.html`
(users, plans, manual plan grants, orders).

**Plans.** Seeded on first boot: **Free** (₹0 · 3 scans · 1.5 km · 50 biz),
**Starter** (₹499 · 25 scans · 3 km · 300 biz · PSI), **Pro** (₹1499 · 100 scans
· 6 km · 1000 biz · PSI). Edit them in the admin panel.

**Payments — Cashfree PG** (one-time order per plan period, API `2023-08-01`):

1. Create a Cashfree account, grab **App ID** + **Secret Key** (start in
   **sandbox**), set `CASHFREE_APP_ID` / `CASHFREE_SECRET_KEY` /
   `CASHFREE_ENV=sandbox`.
2. In the Cashfree dashboard → **Developers → Webhooks**, add a webhook pointing
   at `<APP_BASE_URL>/api/webhooks/cashfree`. Cashfree signs it with your secret
   key, so `CASHFREE_WEBHOOK_SECRET` can stay blank (it defaults to the secret
   key). The endpoint verifies `base64(HMAC-SHA256(timestamp + rawBody, secret))`
   and rejects mismatches with 401.
3. Upgrades run through the Cashfree JS SDK (`Cashfree({mode}).checkout(...)`).
   The return page (`/billing/return`) also polls `GET /api/billing/order/:id`,
   which re-verifies against Cashfree — so payments still activate if the
   webhook is delayed or undeliverable (e.g. on localhost).
4. When ready, switch `CASHFREE_ENV=production`, swap in production keys, and
   re-point the webhook at your production URL.

**Deploy to Railway / Render** (persistent disk, always-on):

1. Push this repo; the included `Dockerfile` (`node:22-slim`, `npm ci`,
   `npm start` via `tsx` — no build step) and `railway.json` are ready to go.
2. Set env vars (see `.env.example`): at minimum `SESSION_SECRET`
   (`openssl rand -hex 32`), `APP_BASE_URL` (your public https URL),
   `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `NODE_ENV=production`, and a data source key
   (`GOOGLE_MAPS_API_KEY` / `APIFY_TOKEN`, or `DEMO=1`).
3. **Mount two persistent volumes** so data survives redeploys:
   `/app/data` (users/plans/subscriptions/orders) and `/app/leads` (generated
   lead files + per-user CRM). Override locations with `DATA_DIR`.
4. Health check: `GET /healthz` → `{ "ok": true }`.

`SESSION_SECRET` is **required** when `NODE_ENV=production` (the process refuses
to start without it); in dev a random per-boot secret is used with a warning.

## Output

```
leads/<userId>/2026-07-05-1432-12.9758_77.6045/
  SUMMARY.md            # ranked table + "most winnable" shortlist
  summary.html          # visual gallery of lead cards → previews
  leads.json            # full machine-readable data
  .crm.json             # (at leads/<userId>/ root) pipeline status across scans
  sharma-dental-clinic.md          # pitch-ready brief
  sharma-dental-clinic.prompt.md   # paste into Claude to generate the pitch
  sharma-dental-clinic.preview.html # mock landing page ("the free mock-up")
  sharma-dental-clinic.audit.html   # printable audit one-pager
  sharma-dental-clinic.jpg          # mobile screenshot (--psi only)
  pack/sharma-dental-clinic/        # bundle of the above (--pack only)
  ...
```

Each brief has YAML frontmatter (name/kind/score/winnability/est_value/phone/
email/whatsapp/address/links) then: business facts → audit findings → what they
need → pitch angles → **why this scored N** → **outreach drafts** (WhatsApp/
email/SMS with click-ready links) → suggested opener → artifact links.

## How scoring works

- **Website audit score (0–100)**: starts at 100, issues subtract by severity
  (critical −25, major −12, minor −5). Healthy = score ≥ 70 with no critical
  issues → not a lead. Weights are tunable via `SCORING_WEIGHTS` (JSON) in `.env`.
- **Lead score (0–100)**: base by kind (broken 75 > no-website 65 >
  needs-improvement 30 + severity bonus), plus popularity (+up to 15 from review
  count, or an OSM maturity proxy when ratings are absent), thriving-business
  bonus, high-value category bonus (dentist/lawyer/doctor/real-estate/…),
  **competitor-density bonus** (rivals nearby who already have a real site),
  minus a **national-chain** penalty and a not-operational penalty. Each lead
  carries an itemised **score-reason** breakdown, a **₹ value estimate** and a
  **winnability** rating.
- **CRM**: every scanned business is recorded by id; repeat scans mark leads
  new-vs-seen, carry their status forward, and drop suppressed (do-not-contact)
  businesses.

## Architecture

```
src/types.ts       shared contract (all interfaces + module contracts)
src/categories.ts  category groups, category value map, chain list
src/config.ts      .env loader (data-source precedence + scoring weights)
src/grid.ts        big circle -> overlapping cells (Nearby caps at 20/call)
src/phone.ts       Indian phone -> E.164 + wa.me (pure)
src/places.ts      source router + Google Places (New) client
src/overpass.ts    free OpenStreetMap Overpass source + maturity proxy
src/apify.ts       paid Apify Google-Maps scraper source
src/merge.ts       OSM + paid source dedup/overlay (haversine + name)
src/mock.ts        deterministic demo businesses + demo audits
src/audit.ts       fetch + HTML analysis, PSI/CWV, link checks (pure analyzeHtml)
src/score.ts       scoring, classification, needs, pitch, value, winnability
src/outreach.ts    WhatsApp/email/SMS message packs
src/mockpage.ts    per-lead mock landing page
src/onepager.ts    printable audit one-pager
src/store.ts       CRM persistence (.crm.json), status/notes/follow-ups
src/draft.ts       optional local-model auto-draft via ensemble CLI
src/markdown.ts    per-lead brief/prompt/artifacts + SUMMARY + gallery + json
src/scan.ts        pipeline: search -> audit -> classify -> competitor -> CRM -> write
src/server.ts      express: static UI + SSE scan + CRM pipeline API + CSV export
src/cli.ts         headless scans
public/            vanilla JS + Leaflet dark map UI (filters, status, history)
```

Stack: TypeScript ESM, `tsx` runtime, Express, vitest. Frontend is
dependency-free vanilla JS + Leaflet (CDN) + CARTO dark tiles + Nominatim
place search.
