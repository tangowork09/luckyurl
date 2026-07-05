/**
 * Lead file writer. Per lead it emits:
 *   <slug>.md          pitch-ready brief (frontmatter + facts + audit + needs +
 *                      pitch angles + score reasons + outreach + opener)
 *   <slug>.prompt.md   a ready-to-paste directive that tells Claude to generate
 *                      the actual pitch artifact from the embedded facts
 *   <slug>.preview.html a self-contained mock landing page ("the free mock-up")
 *   <slug>.audit.html   a printable audit one-pager
 *   <slug>.jpg          mobile screenshot, when PSI captured one
 * Plus SUMMARY.md, summary.html (visual gallery) and leads.json per scan.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { renderMockPage } from './mockpage';
import { renderOnePager } from './onepager';
import { buildMessages, suggestedOpener } from './outreach';
import type { Lead, ScanResult, WebsiteAudit } from './types';

export interface WriteOptions {
  /** Also bundle the top N leads into pack/<slug>/ folders. 0/undefined = off. */
  pack?: number;
  /** Pre-generated pitch drafts keyed by business id (from draft.ts). */
  drafts?: Map<string, string>;
}

/** Must match the frontend's slugify (public/app.js) so links resolve. */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function scanDirName(startedAt: string, lat: number, lng: number): string {
  const d = new Date(startedAt);
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
  return `${stamp}-${lat.toFixed(4)}_${lng.toFixed(4)}`;
}

/** YAML scalar: quote when it could be misparsed, escape embedded quotes. */
function yamlValue(v: string | number | undefined): string {
  if (v === undefined || v === '') return '""';
  if (typeof v === 'number') return String(v);
  // Unquoted only for strings YAML can't misread: not number/bool/null-like.
  const safe =
    /^[a-zA-Z][a-zA-Z0-9 ._/-]*$/.test(v) &&
    !/^(?:y|yes|n|no|true|false|on|off|null)$/i.test(v.trim());
  if (safe) return v;
  const escaped = v
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\t/g, '\\t')
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f]/g, '');
  return `"${escaped}"`;
}

const KIND_LABEL: Record<Lead['kind'], string> = {
  'no-website': 'No website',
  'broken-website': 'Broken website',
  'needs-improvement': 'Needs improvement',
};

function auditSection(audit: WebsiteAudit | undefined, hasScreenshot: boolean): string {
  if (!audit) return '_No website found on their Google Business Profile._';
  const lines: string[] = [];
  lines.push(`- URL: ${audit.url}${audit.finalUrl && audit.finalUrl !== audit.url ? ` (resolves to ${audit.finalUrl})` : ''}`);
  lines.push(`- Audit score: **${audit.score}/100**`);
  if (audit.httpStatus !== undefined) lines.push(`- HTTP status: ${audit.httpStatus}`);
  if (audit.responseMs !== undefined) lines.push(`- Response time: ${audit.responseMs} ms`);
  if (audit.tech) lines.push(`- Built with: ${audit.tech}`);
  if (audit.jsRendered) lines.push('- Renders content via JavaScript (some crawlers see a blank page)');
  if (audit.psi?.performance !== undefined) lines.push(`- PageSpeed performance: ${audit.psi.performance}/100`);
  if (audit.psi?.accessibility !== undefined) lines.push(`- Accessibility: ${audit.psi.accessibility}/100`);
  if (audit.psi?.seo !== undefined) lines.push(`- PageSpeed SEO: ${audit.psi.seo}/100`);
  if (audit.psi?.lcpMs !== undefined) lines.push(`- Largest Contentful Paint: ${(audit.psi.lcpMs / 1000).toFixed(1)} s`);
  if (audit.emails && audit.emails.length > 0) lines.push(`- Emails on site: ${audit.emails.join(', ')}`);
  if (hasScreenshot) lines.push('- Mobile screenshot: see the `.jpg` next to this file');
  if (audit.issues.length > 0) {
    lines.push('', '| Severity | Issue |', '| -------- | ----- |');
    for (const issue of audit.issues) {
      lines.push(`| ${issue.severity} | ${issue.detail.replace(/\|/g, '\\|')} |`);
    }
  }
  return lines.join('\n');
}

function scoreSection(lead: Lead): string {
  if (lead.scoreReasons.length === 0) return '';
  const rows = lead.scoreReasons.map((r) => `- ${r.points >= 0 ? '+' : ''}${r.points} — ${r.label}`);
  return [`## Why this scored ${lead.leadScore}`, '', ...rows].join('\n');
}

function outreachSection(lead: Lead): string {
  const m = buildMessages(lead);
  const b = lead.business;
  const lines = ['## Outreach', ''];
  lines.push('**WhatsApp / DM:**', '', `> ${m.whatsapp}`, '');
  if (m.whatsappUri) lines.push(`[Open WhatsApp chat](${m.whatsappUri})`, '');
  lines.push('**Email:**', '', `*Subject:* ${m.email.subject}`, '', '```', m.email.body, '```', '');
  if (m.mailtoUri) lines.push(`[Compose email](${m.mailtoUri})`, '');
  else if (!b.email) lines.push('_No email on file — use WhatsApp or the enquiry form._', '');
  lines.push('**SMS:**', '', `> ${m.sms}`);
  return lines.join('\n');
}

interface ArtifactNames {
  preview: string;
  audit: string;
  prompt: string;
}

function leadMarkdown(lead: Lead, hasScreenshot: boolean, artifacts: ArtifactNames): string {
  const b = lead.business;
  const front = [
    '---',
    `name: ${yamlValue(b.name)}`,
    `kind: ${lead.kind}`,
    `score: ${lead.leadScore}`,
    `winnability: ${lead.winnability ?? 'medium'}`,
    `est_value: ${yamlValue(lead.estValue?.label)}`,
    `phone: ${yamlValue(b.phoneE164 ?? b.phone)}`,
    `email: ${yamlValue(b.email ?? lead.audit?.emails?.[0])}`,
    `whatsapp: ${yamlValue(b.whatsappUri)}`,
    `address: ${yamlValue(b.address)}`,
    `maps: ${yamlValue(b.googleMapsUri)}`,
    `website: ${yamlValue(b.websiteUri)}`,
    '---',
  ].join('\n');

  const facts: string[] = [
    `- **Category:** ${(b.primaryType ?? b.types[0] ?? 'unknown').replace(/_/g, ' ')}`,
    `- **Address:** ${b.address || 'unknown'}`,
  ];
  if (b.phone) facts.push(`- **Phone:** ${b.phoneE164 ?? b.phone}`);
  if (b.email ?? lead.audit?.emails?.[0]) facts.push(`- **Email:** ${b.email ?? lead.audit?.emails?.[0]}`);
  if (b.rating !== undefined) facts.push(`- **Rating:** ${b.rating}★ (${b.ratingCount ?? 0} reviews)`);
  if (lead.estValue) facts.push(`- **Estimated project value:** ${lead.estValue.label}`);
  if (lead.context) facts.push(`- **Category competition:** ${lead.context.withHealthySite}/${lead.context.total} nearby have a real site`);
  if (b.businessStatus && b.businessStatus !== 'OPERATIONAL') facts.push(`- **Status:** ${b.businessStatus}`);
  if (b.googleMapsUri) facts.push(`- **Map listing:** ${b.googleMapsUri}`);
  if (b.websiteUri) facts.push(`- **Listed website:** ${b.websiteUri}`);

  return [
    front,
    '',
    `# ${b.name}`,
    '',
    `**${KIND_LABEL[lead.kind]}** · lead score **${lead.leadScore}/100** · winnability **${lead.winnability ?? 'medium'}**`,
    '',
    '## Business facts',
    '',
    facts.join('\n'),
    '',
    '## Audit findings',
    '',
    auditSection(lead.audit, hasScreenshot),
    '',
    '## What they need',
    '',
    lead.needs.map((n) => `- ${n}`).join('\n'),
    '',
    '## Pitch angles',
    '',
    lead.pitchAngles.map((p) => `- ${p}`).join('\n'),
    '',
    scoreSection(lead),
    '',
    outreachSection(lead),
    '',
    '## Suggested opener',
    '',
    `> ${suggestedOpener(lead)}`,
    '',
    '## Artifacts',
    '',
    '- Mock landing page: `' + artifacts.preview + '`',
    '- Printable audit one-pager: `' + artifacts.audit + '`',
    '- Claude pitch prompt: `' + artifacts.prompt + '`',
    '',
  ].join('\n');
}

/** A directive the user pastes into Claude to generate the real pitch artifact. */
export function promptMarkdown(lead: Lead): string {
  const b = lead.business;
  const m = buildMessages(lead);
  return [
    '# Generate a pitch for this lead',
    '',
    'You are a web-design freelancer. Using ONLY the facts below, produce:',
    '1. A short, warm cold-outreach message (WhatsApp-friendly, no jargon).',
    '2. A one-paragraph value proposition tailored to this business.',
    '3. Three concrete deliverables with a one-line benefit each.',
    '',
    'Keep it honest and specific to their situation. Indian local business; prices in INR.',
    '',
    '## Facts',
    '',
    `- Business: ${b.name}`,
    `- Category: ${(b.primaryType ?? b.types[0] ?? 'unknown').replace(/_/g, ' ')}`,
    `- Situation: ${KIND_LABEL[lead.kind]}`,
    `- Address: ${b.address || 'unknown'}`,
    b.rating !== undefined ? `- Reputation: ${b.rating}★ (${b.ratingCount ?? 0} reviews)` : '',
    lead.estValue ? `- Likely budget band: ${lead.estValue.label}` : '',
    lead.audit ? `- Website audit score: ${lead.audit.score}/100` : '- They have no website at all',
    '',
    '### Problems found',
    lead.audit && lead.audit.issues.length > 0
      ? lead.audit.issues.map((i) => `- (${i.severity}) ${i.detail}`).join('\n')
      : '- No website presence to build on',
    '',
    '### What they need',
    lead.needs.map((n) => `- ${n}`).join('\n'),
    '',
    '### Pitch angles to lean on',
    lead.pitchAngles.map((p) => `- ${p}`).join('\n'),
    '',
    '### A starting-point opener (improve on it)',
    `> ${m.whatsapp}`,
    '',
  ]
    .filter((l) => l !== '')
    .join('\n');
}

function summaryMarkdown(
  result: Omit<ScanResult, 'files' | 'outDir'>,
  fileById: Map<string, string>,
): string {
  const { area } = result;
  const rows = result.leads.map((lead) => {
    const b = lead.business;
    const file = fileById.get(b.id) ?? '';
    const contact = b.phoneE164 ?? b.phone ?? b.email ?? '';
    return (
      `| ${lead.leadScore} | [${b.name.replace(/\|/g, '\\|')}](${file}) | ${KIND_LABEL[lead.kind]} ` +
      `| ${lead.winnability ?? ''} | ${lead.estValue?.label ?? ''} | ${lead.needs[0]?.replace(/\|/g, '\\|') ?? ''} | ${contact} |`
    );
  });
  const winnable = result.leads
    .filter((l) => l.winnability === 'easy')
    .slice(0, 5)
    .map((l, i) => `${i + 1}. **${l.business.name}** (${l.leadScore}) — ${l.needs[0] ?? ''}`);

  return [
    `# Lead scan — ${area.center.lat.toFixed(4)}, ${area.center.lng.toFixed(4)} (${area.radiusMeters} m)`,
    '',
    `Scanned ${result.startedAt} → ${result.finishedAt}. Found **${result.totalFound}** businesses, ` +
      `audited ${result.audited} websites, **${result.leads.length} leads** ` +
      `(${result.newLeads ?? result.leads.length} new this scan, ${result.skipped} healthy sites skipped).`,
    '',
    ...(winnable.length > 0 ? ['## Start here — most winnable', '', ...winnable, ''] : []),
    '## All leads',
    '',
    '| Score | Business | Kind | Winnability | Est. value | Top need | Contact |',
    '| ----- | -------- | ---- | ----------- | ---------- | -------- | ------- |',
    ...rows,
    '',
  ].join('\n');
}

/* ------------------------- HTML gallery --------------------------- */

function escHtml(v: string | undefined): string {
  return String(v ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  );
}

const KIND_HTML_COLOR: Record<Lead['kind'], string> = {
  'no-website': '#f87171',
  'broken-website': '#fb923c',
  'needs-improvement': '#facc15',
};

function summaryHtml(
  result: Omit<ScanResult, 'files' | 'outDir'>,
  fileById: Map<string, string>,
): string {
  const cards = result.leads
    .map((lead) => {
      const b = lead.business;
      const md = fileById.get(b.id) ?? '#';
      const preview = md.replace(/\.md$/, '.preview.html');
      return `
      <a class="card" href="${escHtml(preview)}" target="_blank" rel="noopener">
        <div class="head">
          <span class="score">${lead.leadScore}</span>
          <span class="kind" style="color:${KIND_HTML_COLOR[lead.kind]}">${escHtml(KIND_LABEL[lead.kind])}</span>
        </div>
        <h3>${escHtml(b.name)}</h3>
        ${b.rating != null ? `<p class="rating">${escHtml(String(b.rating))}★ · ${escHtml(String(b.ratingCount ?? 0))} reviews</p>` : ''}
        <p class="need">${escHtml(lead.needs[0])}</p>
        ${lead.estValue ? `<p class="val">${escHtml(lead.estValue.label)}</p>` : ''}
        <div class="links"><span>Preview →</span><a href="${escHtml(md)}" target="_blank" rel="noopener">brief</a></div>
      </a>`;
    })
    .join('');

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Leads — ${escHtml(`${result.area.center.lat.toFixed(4)}, ${result.area.center.lng.toFixed(4)}`)}</title>
<style>
  * { box-sizing:border-box; margin:0; padding:0; }
  body { font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif; background:#0d1117; color:#e6edf3; padding:28px; }
  h1 { font-size:1.4rem; margin-bottom:4px; }
  .meta { color:#8b949e; font-size:.9rem; margin-bottom:24px; }
  .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(260px,1fr)); gap:16px; }
  .card { display:block; background:#161b22; border:1px solid #30363d; border-radius:14px; padding:18px; text-decoration:none; color:inherit; transition:border-color .15s, transform .15s; }
  .card:hover { border-color:#2dd4bf; transform:translateY(-2px); }
  .head { display:flex; justify-content:space-between; align-items:center; margin-bottom:8px; }
  .score { font-weight:800; font-size:1.3rem; color:#2dd4bf; }
  .kind { font-size:.78rem; font-weight:700; }
  .card h3 { font-size:1.05rem; margin-bottom:6px; }
  .rating { color:#8b949e; font-size:.82rem; margin-bottom:6px; }
  .need { font-size:.88rem; color:#c9d1d9; margin-bottom:8px; }
  .val { font-size:.82rem; color:#7ee787; margin-bottom:10px; }
  .links { display:flex; justify-content:space-between; font-size:.8rem; color:#2dd4bf; border-top:1px solid #21262d; padding-top:8px; }
  .links a { color:#8b949e; text-decoration:none; }
</style></head>
<body>
  <h1>${escHtml(String(result.leads.length))} leads</h1>
  <p class="meta">${escHtml(`${result.area.center.lat.toFixed(4)}, ${result.area.center.lng.toFixed(4)}`)} · ${escHtml(String(result.area.radiusMeters))} m · ${escHtml(String(result.totalFound))} businesses scanned</p>
  <div class="grid">${cards}</div>
</body></html>`;
}

/* --------------------------- writer ------------------------------- */

export async function writeLeadFiles(
  result: Omit<ScanResult, 'files' | 'outDir'>,
  outDirRoot: string,
  opts: WriteOptions = {},
): Promise<{ files: string[]; outDir: string }> {
  const outDir = resolve(
    outDirRoot,
    scanDirName(result.startedAt, result.area.center.lat, result.area.center.lng),
  );
  await mkdir(outDir, { recursive: true });

  const files: string[] = [];
  const fileById = new Map<string, string>();
  const used = new Set<string>();

  for (let i = 0; i < result.leads.length; i++) {
    const lead = result.leads[i];
    const base = slugify(lead.business.name) || 'lead';
    let slug = base;
    for (let n = 2; used.has(slug); n++) slug = `${base}-${n}`;
    used.add(slug);
    // Keyed by business id so duplicate-named leads link their own files.
    fileById.set(lead.business.id, `${slug}.md`);

    // Screenshot: write the PSI base64 to disk, then strip it so leads.json
    // stays small. Mutating lead.audit here is intentional — it's serialised later.
    let hasScreenshot = false;
    const shot = lead.audit?.psi?.screenshotBase64;
    if (shot) {
      const b64 = shot.replace(/^data:image\/\w+;base64,/, '');
      await writeFile(join(outDir, `${slug}.jpg`), Buffer.from(b64, 'base64'));
      files.push(join(outDir, `${slug}.jpg`));
      if (lead.audit) {
        lead.audit.screenshotPath = `${slug}.jpg`;
        delete lead.audit.psi!.screenshotBase64;
      }
      hasScreenshot = true;
    }

    const flatArtifacts: ArtifactNames = {
      preview: `${slug}.preview.html`,
      audit: `${slug}.audit.html`,
      prompt: `${slug}.prompt.md`,
    };
    await writeFile(join(outDir, `${slug}.md`), leadMarkdown(lead, hasScreenshot, flatArtifacts), 'utf8');
    files.push(join(outDir, `${slug}.md`));

    await writeFile(join(outDir, `${slug}.prompt.md`), promptMarkdown(lead), 'utf8');
    files.push(join(outDir, `${slug}.prompt.md`));

    await writeFile(join(outDir, `${slug}.preview.html`), renderMockPage(lead), 'utf8');
    files.push(join(outDir, `${slug}.preview.html`));

    await writeFile(join(outDir, `${slug}.audit.html`), renderOnePager(lead), 'utf8');
    files.push(join(outDir, `${slug}.audit.html`));

    const draft = opts.drafts?.get(lead.business.id);
    if (draft) {
      await writeFile(join(outDir, `${slug}.draft.md`), draft, 'utf8');
      files.push(join(outDir, `${slug}.draft.md`));
    }

    // Pack: bundle the top N leads into a self-contained folder to send as one.
    if (opts.pack && i < opts.pack) {
      const bundle = join(outDir, 'pack', slug);
      await mkdir(bundle, { recursive: true });
      // Pack brief must reference the pack's own filenames, not the flat ones.
      const packArtifacts: ArtifactNames = { preview: 'index.html', audit: 'audit.html', prompt: 'prompt.md' };
      await writeFile(join(bundle, 'index.html'), renderMockPage(lead), 'utf8');
      await writeFile(join(bundle, 'audit.html'), renderOnePager(lead), 'utf8');
      await writeFile(join(bundle, 'brief.md'), leadMarkdown(lead, hasScreenshot, packArtifacts), 'utf8');
      await writeFile(join(bundle, 'prompt.md'), promptMarkdown(lead), 'utf8');
      files.push(join(bundle, 'index.html'), join(bundle, 'audit.html'), join(bundle, 'brief.md'), join(bundle, 'prompt.md'));
    }
  }

  const summaryPath = join(outDir, 'SUMMARY.md');
  await writeFile(summaryPath, summaryMarkdown(result, fileById), 'utf8');
  files.push(summaryPath);

  const summaryHtmlPath = join(outDir, 'summary.html');
  await writeFile(summaryHtmlPath, summaryHtml(result, fileById), 'utf8');
  files.push(summaryHtmlPath);

  const jsonPath = join(outDir, 'leads.json');
  await writeFile(jsonPath, JSON.stringify(result, null, 2), 'utf8');
  files.push(jsonPath);

  return { files, outDir };
}
