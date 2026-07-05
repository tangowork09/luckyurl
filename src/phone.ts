/**
 * Indian phone normalization — pure and testable.
 *
 * Handles the messy shapes real listings carry: "+91 90000 00000",
 * "090000-00000", "9000000000", "91 9000000000", "tel:+919000000000".
 * Returns E.164 + a wa.me click-to-chat link when the digits look like a
 * valid Indian mobile/landline; otherwise leaves fields undefined.
 */
export interface NormalizedPhone {
  /** E.164, e.g. "+919876543210". */
  e164?: string;
  /** https://wa.me/919876543210 (digits only, no +). */
  whatsappUri?: string;
  /** Display form, spaced for readability. */
  display?: string;
}

/** Strip to digits, dropping a leading +. */
function digitsOnly(raw: string): string {
  return raw.replace(/[^\d]/g, '');
}

export function normalizeIndianPhone(raw: string | undefined): NormalizedPhone {
  if (!raw) return {};
  let d = digitsOnly(raw);

  // Drop international prefixes: 00 91… or 0 (STD trunk) prefixes.
  if (d.startsWith('00')) d = d.slice(2);
  if (d.startsWith('91') && d.length > 10) d = d.slice(2);
  // A single trunk 0 before a 10-digit number ("09000000000").
  if (d.length === 11 && d.startsWith('0')) d = d.slice(1);

  // Indian mobile numbers are 10 digits starting 6-9. Landlines vary (STD +
  // subscriber = up to 10 after trunk); accept a plain 10-digit fallback too.
  if (d.length !== 10) return {};
  const national = d;
  const e164 = `+91${national}`;

  return {
    e164,
    whatsappUri: `https://wa.me/91${national}`,
    display: `+91 ${national.slice(0, 5)} ${national.slice(5)}`,
  };
}
