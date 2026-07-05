/**
 * Mock landing-page generator — the flagship artifact.
 *
 * Renders a self-contained (inline CSS, no external requests), deterministic
 * one-page website preview per lead, styled by business category. This is the
 * "free mock-up" the outreach opener promises: the freelancer sends the prospect
 * a live demo of what their site could look like, generated from their own
 * Google/OSM listing data. No API key, no network — pure string in, HTML out.
 */
import type { Business, Lead } from './types';

interface Theme {
  bg: string;
  accent: string;
  accent2: string;
  hero: string; // hero headline
  sections: { title: string; blurb: string }[];
}

function esc(v: string | undefined): string {
  return String(v ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  );
}

function groupKey(b: Business): string {
  const t = (b.primaryType ?? b.types[0] ?? '').toLowerCase();
  if (/rest|cafe|bakery|bar|food|meal|coffee|ice_cream/.test(t)) return 'food';
  if (/hotel|motel|guest|resort|hostel|lodging|bed_and/.test(t)) return 'lodging';
  if (/school|univ|college|preschool|tutor|educat|child_care/.test(t)) return 'education';
  if (/dent|doct|physio|pharma|vet|clinic|health|hospital|optom|medical|nursing/.test(t)) return 'health';
  if (/beauty|hair|salon|barber|spa|nail|tattoo/.test(t)) return 'beauty';
  if (/gym|yoga|fitness|dance|martial|swim/.test(t)) return 'fitness';
  if (/law|account|insur|estate|travel|financ|architect|consult|marketing/.test(t)) return 'professional';
  if (/supermarket|grocery|liquor|butcher|greengrocer|market/.test(t)) return 'grocery';
  if (/cinema|movie|night_club|bowling|amusement|event|banquet|attraction/.test(t)) return 'entertainment';
  if (/store|shop|retail|jewel|cloth|furni|electro/.test(t)) return 'retail';
  return 'default';
}

function themeFor(b: Business): Theme {
  switch (groupKey(b)) {
    case 'food':
      return {
        bg: '#1a1210', accent: '#e8763a', accent2: '#f2b705',
        hero: 'Fresh, made-to-order, every day',
        sections: [
          { title: 'Our Menu', blurb: 'Handpicked dishes prepared fresh with local ingredients.' },
          { title: 'Order & Reserve', blurb: 'Dine in, take away, or book a table in seconds.' },
          { title: 'Visit Us', blurb: 'Find us, see our hours, and get directions.' },
        ],
      };
    case 'health':
      return {
        bg: '#0e1620', accent: '#2a9d8f', accent2: '#4cc9f0',
        hero: 'Trusted care, close to home',
        sections: [
          { title: 'Our Services', blurb: 'Comprehensive treatments delivered with care and experience.' },
          { title: 'Book an Appointment', blurb: 'Choose a time that works for you — online, any time.' },
          { title: 'Find Us', blurb: 'Location, opening hours and how to reach us.' },
        ],
      };
    case 'beauty':
      return {
        bg: '#1a1018', accent: '#d16ba5', accent2: '#c77dff',
        hero: 'Look good. Feel better.',
        sections: [
          { title: 'Treatments & Prices', blurb: 'A full menu of services for every occasion.' },
          { title: 'Book Online', blurb: 'Reserve your slot in a few taps.' },
          { title: 'Where to Find Us', blurb: 'Directions, hours and contact details.' },
        ],
      };
    case 'fitness':
      return {
        bg: '#0f1410', accent: '#7cb518', accent2: '#c1ff72',
        hero: 'Stronger starts here',
        sections: [
          { title: 'Classes & Memberships', blurb: 'Plans and sessions for every level and goal.' },
          { title: 'Start Your Trial', blurb: 'Book a free intro session today.' },
          { title: 'Our Studio', blurb: 'Location, timings and how to join.' },
        ],
      };
    case 'professional':
      return {
        bg: '#0d1220', accent: '#3a86ff', accent2: '#8ecae6',
        hero: 'Expert help you can rely on',
        sections: [
          { title: 'What We Do', blurb: 'Professional services tailored to your needs.' },
          { title: 'Get in Touch', blurb: 'Request a consultation — we respond within a day.' },
          { title: 'Our Office', blurb: 'Address, hours and contact information.' },
        ],
      };
    case 'retail':
    case 'grocery':
      return {
        bg: '#141018', accent: '#ff6b6b', accent2: '#ffd166',
        hero: 'Quality you can shop with confidence',
        sections: [
          { title: 'Our Range', blurb: 'Browse what we stock, in store and to order.' },
          { title: 'Enquire', blurb: 'Ask about stock, prices and delivery.' },
          { title: 'Visit the Store', blurb: 'Location, opening hours and directions.' },
        ],
      };
    case 'lodging':
      return {
        bg: '#0f1218', accent: '#c9a35e', accent2: '#e8d3a8',
        hero: 'Your comfortable stay awaits',
        sections: [
          { title: 'Rooms & Rates', blurb: 'Comfortable rooms for every budget and occasion.' },
          { title: 'Book Your Stay', blurb: 'Check availability and reserve in a few taps.' },
          { title: 'Find Us', blurb: 'Location, amenities and how to reach us.' },
        ],
      };
    case 'education':
      return {
        bg: '#0c1420', accent: '#4f9dde', accent2: '#a8d0f0',
        hero: 'Learning that sets you up to succeed',
        sections: [
          { title: 'Courses & Programs', blurb: 'Structured programs led by experienced faculty.' },
          { title: 'Enrol / Enquire', blurb: 'Request details, fees and the next batch dates.' },
          { title: 'Visit the Campus', blurb: 'Location, timings and how to reach us.' },
        ],
      };
    case 'entertainment':
      return {
        bg: '#160f1c', accent: '#a855f7', accent2: '#f0abfc',
        hero: 'Where the fun happens',
        sections: [
          { title: "What's On", blurb: 'Shows, events and everything happening this week.' },
          { title: 'Book Tickets', blurb: 'Reserve your spot or enquire about private events.' },
          { title: 'Find Us', blurb: 'Location, timings and directions.' },
        ],
      };
    default:
      return {
        bg: '#101418', accent: '#2dd4bf', accent2: '#8ec5ff',
        hero: 'Everything you need, in one place',
        sections: [
          { title: 'What We Offer', blurb: 'Our services and what makes us different.' },
          { title: 'Contact Us', blurb: 'Get in touch — we would love to help.' },
          { title: 'Find Us', blurb: 'Location, hours and how to reach us.' },
        ],
      };
  }
}

export function renderMockPage(lead: Lead): string {
  const b = lead.business;
  const t = themeFor(b);
  const rating =
    b.rating != null ? `${b.rating.toFixed(1)}★ · ${b.ratingCount ?? 0} reviews` : '';
  const tel = b.phoneE164 ?? b.phone ?? '';
  const wa = b.whatsappUri ?? '';

  const cards = t.sections
    .map(
      (s) => `
      <article class="card">
        <h3>${esc(s.title)}</h3>
        <p>${esc(s.blurb)}</p>
      </article>`,
    )
    .join('');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(b.name)}</title>
<style>
  :root { --bg:${t.bg}; --accent:${t.accent}; --accent2:${t.accent2}; }
  * { box-sizing:border-box; margin:0; padding:0; }
  body { font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif; background:var(--bg); color:#f4f4f5; line-height:1.6; }
  .wrap { max-width:960px; margin:0 auto; padding:0 20px; }
  header { padding:16px 0; display:flex; justify-content:space-between; align-items:center; }
  .logo { font-weight:800; font-size:1.25rem; color:var(--accent); letter-spacing:-.02em; }
  nav a { color:#f4f4f5; text-decoration:none; margin-left:20px; font-size:.9rem; opacity:.85; }
  .hero { padding:72px 0 64px; text-align:center; background:radial-gradient(1200px 400px at 50% -10%, color-mix(in srgb, var(--accent) 22%, transparent), transparent); }
  .hero h1 { font-size:clamp(2rem,5vw,3.4rem); font-weight:800; letter-spacing:-.03em; margin-bottom:12px; }
  .hero .sub { font-size:1.15rem; opacity:.8; max-width:560px; margin:0 auto 8px; }
  .rating { display:inline-block; margin-top:14px; padding:6px 14px; border-radius:999px; background:color-mix(in srgb, var(--accent2) 18%, transparent); color:var(--accent2); font-weight:600; font-size:.9rem; }
  .cta { margin-top:28px; display:flex; gap:12px; justify-content:center; flex-wrap:wrap; }
  .btn { padding:13px 24px; border-radius:12px; font-weight:700; text-decoration:none; font-size:1rem; }
  .btn-primary { background:var(--accent); color:#0a0a0a; }
  .btn-ghost { border:1.5px solid color-mix(in srgb, var(--accent) 55%, transparent); color:#fff; }
  .grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(240px,1fr)); gap:18px; padding:48px 0; }
  .card { background:rgba(255,255,255,.04); border:1px solid rgba(255,255,255,.07); border-radius:16px; padding:24px; }
  .card h3 { color:var(--accent2); font-size:1.15rem; margin-bottom:8px; }
  .card p { opacity:.82; font-size:.95rem; }
  .contact { text-align:center; padding:40px 0 20px; border-top:1px solid rgba(255,255,255,.07); }
  .contact p { opacity:.85; }
  footer { text-align:center; padding:28px 0; font-size:.8rem; opacity:.5; }
  .badge { position:fixed; bottom:14px; right:14px; background:#0a0a0a; color:#8ec5ff; border:1px solid rgba(255,255,255,.15); padding:8px 12px; border-radius:10px; font-size:.72rem; font-family:ui-monospace,monospace; }
</style>
</head>
<body>
  <div class="wrap">
    <header>
      <div class="logo">${esc(b.name)}</div>
      <nav><a href="#services">Services</a><a href="#contact">Contact</a></nav>
    </header>
  </div>

  <section class="hero">
    <div class="wrap">
      <h1>${esc(b.name)}</h1>
      <p class="sub">${esc(t.hero)}.</p>
      ${rating ? `<div class="rating">${esc(rating)}</div>` : ''}
      <div class="cta">
        ${tel ? `<a class="btn btn-primary" href="tel:${esc(tel.replace(/[^+\d]/g, ''))}">Call now</a>` : ''}
        ${wa ? `<a class="btn btn-ghost" href="${esc(wa)}">WhatsApp us</a>` : ''}
      </div>
    </div>
  </section>

  <div class="wrap" id="services">
    <div class="grid">${cards}</div>
  </div>

  <section class="contact" id="contact">
    <div class="wrap">
      <h3 style="color:var(--accent);font-size:1.3rem;margin-bottom:10px">Visit ${esc(b.name)}</h3>
      ${b.address ? `<p>${esc(b.address)}</p>` : ''}
      ${tel ? `<p>${esc(tel)}</p>` : ''}
      ${b.email ? `<p>${esc(b.email)}</p>` : ''}
    </div>
  </section>

  <footer>© ${esc(String(new Date().getFullYear()))} ${esc(b.name)}. All rights reserved.</footer>
  <div class="badge">LeadScout mock-up — a preview of what your site could be</div>
</body>
</html>`;
}
