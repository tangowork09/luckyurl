import { describe, expect, it } from 'vitest';
import { isDisposableEmailDomain } from '../src/disposable-domains';

describe('isDisposableEmailDomain', () => {
  it('rejects known disposable / temp-mail domains', () => {
    for (const email of [
      'x@mailinator.com',
      'y@guerrillamail.com',
      'z@10minutemail.com',
      'a@yopmail.com',
      'b@temp-mail.org',
      'c@sharklasers.com',
      'd@trashmail.com',
    ]) {
      expect(isDisposableEmailDomain(email), email).toBe(true);
    }
  });

  it('is case-insensitive and matches common subdomain forms', () => {
    expect(isDisposableEmailDomain('User@MAILINATOR.com')).toBe(true);
    expect(isDisposableEmailDomain('user@mail.mailinator.com')).toBe(true);
    expect(isDisposableEmailDomain('user@inbox.yopmail.com')).toBe(true);
  });

  it('accepts ordinary permanent email domains', () => {
    for (const email of [
      'founder@gmail.com',
      'ceo@acmecorp.co',
      'hi@sharmadental.in',
      'me@outlook.com',
      'work@company.example',
    ]) {
      expect(isDisposableEmailDomain(email), email).toBe(false);
    }
  });

  it('does not match a lookalike domain that merely contains a blocked label', () => {
    expect(isDisposableEmailDomain('user@notmailinator-company.com')).toBe(false);
    expect(isDisposableEmailDomain('user@mailinatorx.com')).toBe(false);
  });

  it('returns false for malformed input', () => {
    expect(isDisposableEmailDomain('no-at-sign')).toBe(false);
    expect(isDisposableEmailDomain('user@')).toBe(false);
    expect(isDisposableEmailDomain('')).toBe(false);
  });
});
