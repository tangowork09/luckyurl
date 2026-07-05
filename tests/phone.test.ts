import { describe, expect, it } from 'vitest';
import { normalizeIndianPhone } from '../src/phone';

describe('normalizeIndianPhone', () => {
  it('normalizes a spaced +91 mobile', () => {
    const p = normalizeIndianPhone('+91 98765 43210');
    expect(p.e164).toBe('+919876543210');
    expect(p.whatsappUri).toBe('https://wa.me/919876543210');
  });

  it('handles a bare 10-digit number', () => {
    expect(normalizeIndianPhone('9876543210').e164).toBe('+919876543210');
  });

  it('strips a leading trunk 0', () => {
    expect(normalizeIndianPhone('09876543210').e164).toBe('+919876543210');
  });

  it('strips a 91 country prefix without +', () => {
    expect(normalizeIndianPhone('919876543210').e164).toBe('+919876543210');
  });

  it('strips a 0091 international prefix', () => {
    expect(normalizeIndianPhone('00919876543210').e164).toBe('+919876543210');
  });

  it('ignores punctuation and spacing', () => {
    expect(normalizeIndianPhone('(098765) 43210').e164).toBe('+919876543210');
  });

  it('returns empty for junk or wrong-length input', () => {
    expect(normalizeIndianPhone('12345').e164).toBeUndefined();
    expect(normalizeIndianPhone(undefined).e164).toBeUndefined();
    expect(normalizeIndianPhone('not a phone').e164).toBeUndefined();
  });
});
