/**
 * Curated static blocklist of disposable / temp-mail domains.
 *
 * Used at registration to reject throwaway signups WITHOUT sending a
 * verification email (that's scaffolded but off — see server.ts register +
 * config REQUIRE_EMAIL_VERIFICATION). Match is case-insensitive and covers
 * common subdomain forms: `isDisposableEmailDomain` walks each domain suffix
 * so `foo.mailinator.com` still matches `mailinator.com`.
 *
 * This is intentionally a maintainable static Set (no runtime dependency / no
 * network call). Extend it freely — order doesn't matter.
 */
export const DISPOSABLE_EMAIL_DOMAINS: ReadonlySet<string> = new Set([
  // mailinator + aliases
  'mailinator.com', 'mailinator.net', 'mailinator2.com', 'reallymymail.com', 'sogetthis.com',
  'thisisnotmyrealemail.com', 'binkmail.com', 'bobmail.info', 'chammy.info', 'devnullmail.com',
  'letthemeatspam.com', 'mailin8r.com', 'notmailinator.com', 'spamherelots.com', 'suremail.info',
  'tradermail.info', 'veryrealemail.com',
  // guerrillamail family
  'guerrillamail.com', 'guerrillamail.net', 'guerrillamail.org', 'guerrillamail.biz', 'guerrillamail.de',
  'guerrillamailblock.com', 'grr.la', 'sharklasers.com', 'spam4.me', 'pokemail.net',
  // 10minutemail family
  '10minutemail.com', '10minutemail.net', '10minutemail.org', '10minemail.com', '10minutemail.co.uk',
  '10minutemail.de', '20minutemail.com', '20minutemail.it', '30minutemail.com',
  // temp-mail family
  'temp-mail.org', 'temp-mail.io', 'temp-mail.ru', 'tempmail.com', 'tempmail.net', 'tempmail.us',
  'tempmailo.com', 'tempmail.plus', 'tempmailaddress.com', 'tempail.com', 'tempinbox.com',
  'tempemail.com', 'tempemail.net', 'tempemails.io', 'tempr.email', 'tmpmail.org', 'tmpmail.net',
  'tmpeml.com', 'tmpbox.net', 'moakt.com', 'moakt.cc', 'moakt.co', 'disbox.net',
  // yopmail family
  'yopmail.com', 'yopmail.net', 'yopmail.fr', 'cool.fr.nf', 'jetable.fr.nf', 'nospam.ze.tc',
  'nomail.xl.cx', 'mega.zik.dj', 'speed.1s.fr', 'courriel.fr.nf', 'moncourrier.fr.nf',
  'monemail.fr.nf', 'monmail.fr.nf',
  // getnada / nada
  'getnada.com', 'nada.email', 'nada.ltd', 'inboxbear.com', 'robot-mail.com',
  // maildrop / mailnesia / mailcatch
  'maildrop.cc', 'mailnesia.com', 'mailcatch.com', 'mailnull.com', 'spambog.com', 'spambog.de',
  'spambog.ru', 'trbvm.com', 'trbvn.com',
  // mohmal
  'mohmal.com', 'mohmal.in', 'mohmal.tech', 'mohmal.im',
  // fakemail / fake inbox
  'fakemail.net', 'fakeinbox.com', 'fakeinbox.net', 'fakemailgenerator.com', 'fake-mail.ml',
  'fakemail.fr', 'emailfake.com', 'email-fake.com', 'fakemailz.com', 'anonbox.net',
  // throwaway / trash mail
  'throwawaymail.com', 'throwam.com', 'trashmail.com', 'trashmail.net', 'trashmail.de',
  'trashmail.org', 'trashmail.me', 'trashmail.ws', 'trash-mail.com', 'trash-mail.de',
  'kurzepost.de', 'objectmail.com', 'proxymail.eu', 'rcpt.at', 'wegwerfmail.de', 'wegwerfmail.net',
  'wegwerfmail.org', 'wegwerpmailadres.nl', 'nepwerk.eu',
  // dispostable / discard
  'dispostable.com', 'discard.email', 'discardmail.com', 'discardmail.de', 'spam.la', 'spamgourmet.com',
  'spamgourmet.net', 'spamgourmet.org', 'spamavert.com', 'spambox.us', 'spamfree24.org',
  'spamfree24.de', 'spamfree24.com', 'kill-the-spam.com',
  // mailexpire / one-time
  'mailexpire.com', 'onewaymail.com', 'one-time.email', 'anonymbox.com', 'e4ward.com', 'emailtemporario.com.br',
  'emailondeck.com', 'emailtemporanea.com', 'emailtemporanea.net', 'emailthe.net', 'emailwarden.com',
  // burner
  'burnermail.io', 'burnthespam.info', 'burnermsg.com', 'boun.cr', 'deadaddress.com',
  // instances of common temp providers
  'mailinator.org', 'mailboxy.fun', 'mailto.plus', 'fexpost.com', 'fexbox.org', 'mailbox.in.ua',
  'rover.info', 'inpwa.com', 'chitthi.in', 'fextemp.com', 'any.pink', 'merepost.com', 'vddan.com',
  'ymail.pro', 'proton.plus', 'givmail.com', 'sofimail.com',
  // mailtemp / temp providers
  'mailtemp.info', 'mailtempi.com', 'tmail.ws', 'tmails.net', 'tmailor.com', 'internxt.com',
  '33mail.com', 'einrot.com', 'cuvox.de', 'dayrep.com', 'fleckens.hu', 'gustr.com', 'jourrapide.com',
  'rhyta.com', 'superrito.com', 'teleworm.us', 'armyspy.com',
  // more well-known throwaways
  'getairmail.com', 'harakirimail.com', 'incognitomail.org', 'jetable.org', 'jetable.com',
  'mailmoat.com', 'mailquack.com', 'mailsac.com', 'mytemp.email', 'mvrht.com', 'no-spam.ws',
  'nowmymail.com', 'objectmail.com', 'owlymail.com', 'pjjkp.com', 'quickinbox.com',
  'reginald-mail.com', 'shitmail.me', 'shitmail.org', 'smellfear.com', 'snakemail.com',
  'sneakemail.com', 'sofort-mail.de', 'spamcowboy.com', 'spamcowboy.net', 'spamcowboy.org',
  'spamdecoy.net', 'spaml.com', 'tempomail.fr', 'tempsky.com', 'thankyou2010.com', 'trickmail.net',
  'wh4f.org', 'willselfdestruct.com', 'yep.it', 'zoemail.com', 'zoemail.net', 'zoemail.org',
  'mailde.de', 'mailde.info', 'mailmetrash.com', 'meltmail.com', 'mintemail.com', 'mailhz.me',
  'mailzilla.com', 'mailzilla.org', 'mailtothis.com', 'mailtrash.net',
]);

/**
 * True when `email`'s domain (or any parent suffix of it) is a known disposable
 * / temp-mail domain. Case-insensitive. Returns false for obviously malformed
 * input (no '@'); real validation of the address happens elsewhere.
 */
export function isDisposableEmailDomain(email: string): boolean {
  const at = email.lastIndexOf('@');
  if (at < 0) return false;
  const domain = email.slice(at + 1).toLowerCase().trim().replace(/\.$/, '');
  if (!domain || !domain.includes('.')) return false;
  const labels = domain.split('.');
  // Check the full domain and each parent suffix: sub.mailinator.com →
  // "sub.mailinator.com", "mailinator.com", "com".
  for (let i = 0; i < labels.length - 1; i++) {
    if (DISPOSABLE_EMAIL_DOMAINS.has(labels.slice(i).join('.'))) return true;
  }
  return false;
}
