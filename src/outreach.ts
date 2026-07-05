/**
 * Outreach message generation — turns a Lead into ready-to-send WhatsApp,
 * email and SMS drafts. Pure and deterministic. The freelancer copies these
 * verbatim (or tweaks) instead of writing a fresh opener per lead.
 */
import type { Lead } from './types';

export interface OutreachMessages {
  /** wa.me deep link with the message pre-filled, if a WhatsApp number exists. */
  whatsappUri?: string;
  whatsapp: string;
  email: { subject: string; body: string };
  /** mailto: link with subject+body pre-filled, if an email address exists. */
  mailtoUri?: string;
  sms: string;
}

function reputation(lead: Lead): string {
  const b = lead.business;
  return (b.rating ?? 0) >= 4 && (b.ratingCount ?? 0) >= 20
    ? ` — I saw your ${b.rating}★ from ${b.ratingCount} reviews`
    : '';
}

/** The one-line opener (was in markdown.ts). Reused inside every channel. */
export function suggestedOpener(lead: Lead): string {
  const b = lead.business;
  const rep = reputation(lead);
  switch (lead.kind) {
    case 'no-website':
      return (
        `Hi, I came across ${b.name} on the map${rep} and noticed you don't have a website yet. ` +
        `Customers searching for you online only see the bare listing. I build simple one-page sites ` +
        `for local businesses — can I send over a free mock-up of what yours could look like?`
      );
    case 'broken-website':
      return (
        `Hi, quick heads-up: the website linked from ${b.name}'s listing isn't loading right now, so ` +
        `every customer who clicks it hits a dead end. I can get a working site back up quickly — want me to send details?`
      );
    case 'needs-improvement':
      return (
        `Hi, I found ${b.name} on the map${rep} and had a look at your website. A few fixable issues ` +
        `are likely costing you customers (${lead.needs[0]?.toLowerCase() ?? 'details in my audit'}). ` +
        `I put together a short free audit — can I send it over?`
      );
  }
}

export function buildMessages(lead: Lead): OutreachMessages {
  const b = lead.business;
  const opener = suggestedOpener(lead);

  const whatsapp = opener;
  const sms =
    lead.kind === 'broken-website'
      ? `Hi ${b.name} — your website link on Google isn't loading; customers hit a dead page. I can fix it fast. Reply if interested. `
      : `Hi ${b.name} — I help local businesses get more customers online. Can I send you a free website mock-up? `;

  const subject =
    lead.kind === 'broken-website'
      ? `Your website isn't loading — quick fix?`
      : lead.kind === 'no-website'
        ? `A free website mock-up for ${b.name}`
        : `A few quick wins for ${b.name}'s website`;

  const bodyLines = [
    opener,
    '',
    'What I can do:',
    ...lead.needs.slice(0, 3).map((n) => `• ${n}`),
    '',
    'No obligation — happy to show you a sample first.',
    '',
    'Best,',
    '[Your name]',
  ];
  const body = bodyLines.join('\n');

  const messages: OutreachMessages = {
    whatsapp,
    email: { subject, body },
    sms,
  };
  if (b.whatsappUri) {
    messages.whatsappUri = `${b.whatsappUri}?text=${encodeURIComponent(whatsapp)}`;
  }
  if (b.email) {
    messages.mailtoUri = `mailto:${b.email}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  }
  return messages;
}
