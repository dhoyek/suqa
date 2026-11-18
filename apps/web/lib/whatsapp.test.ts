import { describe, expect, it } from 'vitest';
import { normalizePhone } from './whatsapp';

describe('phone numbers in messages', () => {
  it('adds the country code to a number saved the local way', () => {
    expect(normalizePhone('76504996')).toBe('96176504996');          // the driver's number from the shop
    expect(normalizePhone('76 504 996')).toBe('96176504996');
    expect(normalizePhone('03 123 456')).toBe('9613123456');
    expect(normalizePhone('+961 76 540 333')).toBe('96176540333');
    expect(normalizePhone('0096176540333')).toBe('96176540333');
    expect(normalizePhone('96176540333')).toBe('96176540333');
  });
});
