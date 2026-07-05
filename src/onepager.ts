/**
 * Printable audit one-pager — a branded A4 HTML page (print-to-PDF friendly,
 * inline CSS, no network) summarising a lead's website audit and what it's
 * costing them. Makes a solo freelancer's pitch look like an agency's.
 */
import type { Lead, WebsiteAudit } from './types';

function esc(v: string | number | undefined): string {
  return String(v ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  );
}

const SEV_COLOR: Record<string, string> = { critical: '#dc2626', major: '#ea580c', minor: '#ca8a04' };

function gauge(score: number): string {
  const color = score < 40 ? '#dc2626' : score < 70 ? '#ea580c' : '#16a34a';
  return `<div class="gauge"><span style="color:${color}">${score}</span><small>/100</small></div>`;
}

function issuesTable(audit?: WebsiteAudit): string {
  if (!audit || audit.issues.length === 0) {
    return '<p class="muted">No website was found for this business — there is nothing to audit, which is itself the opportunity.</p>';
  }
  const rows = audit.issues
    .slice()
    .sort((a, b) => sevRank(b.severity) - sevRank(a.severity))
    .map(
      (i) => `
      <tr>
        <td><span class="pill" style="background:${SEV_COLOR[i.severity]}">${esc(i.severity)}</span></td>
        <td>${esc(i.detail)}</td>
      </tr>`,
    )
    .join('');
  return `<table class="issues"><thead><tr><th>Severity</th><th>Finding</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function sevRank(s: string): number {
  return s === 'critical' ? 3 : s === 'major' ? 2 : 1;
}

export function renderOnePager(lead: Lead): string {
  const b = lead.business;
  const audit = lead.audit;
  const score = audit?.score ?? 0;
  const value = lead.estValue?.label ?? '';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Website Audit — ${esc(b.name)}</title>
<style>
  @page { size:A4; margin:16mm; }
  * { box-sizing:border-box; margin:0; padding:0; }
  body { font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif; color:#111827; line-height:1.5; background:#fff; }
  .sheet { max-width:800px; margin:0 auto; padding:32px; }
  .top { display:flex; justify-content:space-between; align-items:flex-start; border-bottom:3px solid #111827; padding-bottom:16px; }
  .top h1 { font-size:1.6rem; letter-spacing:-.02em; }
  .top .sub { color:#6b7280; font-size:.9rem; margin-top:4px; }
  .gauge { text-align:center; }
  .gauge span { font-size:2.6rem; font-weight:800; }
  .gauge small { color:#6b7280; font-size:.9rem; }
  h2 { font-size:.82rem; letter-spacing:.08em; text-transform:uppercase; margin:26px 0 10px; color:#0f766e; }
  .issues { width:100%; border-collapse:collapse; font-size:.86rem; }
  .issues th { text-align:left; color:#6b7280; font-weight:600; padding:6px 8px; border-bottom:1px solid #e5e7eb; }
  .issues td { padding:8px; border-bottom:1px solid #f3f4f6; vertical-align:top; }
  .pill { color:#fff; font-size:.7rem; font-weight:700; padding:2px 8px; border-radius:999px; text-transform:uppercase; }
  ul.needs { list-style:none; }
  ul.needs li { padding:6px 0 6px 22px; position:relative; font-size:.9rem; }
  ul.needs li::before { content:"→"; position:absolute; left:0; color:#2dd4bf; font-weight:700; }
  .cost { background:#fef2f2; border:1px solid #fecaca; border-radius:10px; padding:14px 16px; margin-top:12px; font-size:.9rem; }
  .cost b { color:#dc2626; }
  .val { background:#f0fdfa; border:1px solid #99f6e4; border-radius:10px; padding:14px 16px; margin-top:12px; font-size:.9rem; }
  .muted { color:#6b7280; font-style:italic; }
  footer { margin-top:28px; padding-top:14px; border-top:1px solid #e5e7eb; color:#9ca3af; font-size:.78rem; text-align:center; }
  @media print { .sheet { padding:0; } }
</style>
</head>
<body>
  <div class="sheet">
    <div class="top">
      <div>
        <h1>${esc(b.name)}</h1>
        <div class="sub">Website audit · ${esc(b.address)}</div>
        ${b.rating != null ? `<div class="sub">${esc(b.rating)}★ from ${esc(b.ratingCount ?? 0)} reviews</div>` : ''}
      </div>
      ${audit ? gauge(score) : '<div class="gauge"><span style="color:#dc2626">—</span><small>no site</small></div>'}
    </div>

    <h2>What we found</h2>
    ${issuesTable(audit)}

    <h2>What this is costing you</h2>
    <div class="cost">
      ${b.rating != null && (b.ratingCount ?? 0) >= 20
        ? `<b>You have earned ${esc(b.rating)}★ from ${esc(b.ratingCount)} reviews</b> — but that reputation converts to almost nothing online today. `
        : ''}
      Every customer who searches for you and can't find a working, modern website goes to a competitor who has one.
    </div>

    <h2>What we recommend</h2>
    <ul class="needs">
      ${lead.needs.map((n) => `<li>${esc(n)}</li>`).join('')}
    </ul>
    ${value ? `<div class="val">Typical investment for work like this: <b>${esc(value)}</b>. A single new customer a month usually covers it.</div>` : ''}

    <footer>Prepared with LeadScout · This audit is a free, no-obligation summary.</footer>
  </div>
</body>
</html>`;
}
