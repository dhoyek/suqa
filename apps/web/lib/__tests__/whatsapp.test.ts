import { describe, it, expect } from 'vitest';
import { normalizePhone, waLink, telLink } from '../whatsapp';

describe('phone normalisation (Lebanon)', () => {
  it('expands local formats to 961', () => {
    expect(normalizePhone('03 123 456')).toBe('96103123456'.replace('9610', '961'));
    expect(normalizePhone('70-123-456')).toBe('96170123456');
    expect(normalizePhone('+961 70 123 456')).toBe('96170123456');
    expect(normalizePhone('0096170123456')).toBe('96170123456');
    expect(normalizePhone('96170123456')).toBe('96170123456');
  });
  it('rejects garbage', () => { expect(normalizePhone('')).toBeNull(); expect(normalizePhone('12')).toBeNull(); expect(normalizePhone(null)).toBeNull(); });
  it('builds wa.me and tel links', () => {
    expect(waLink('70 123 456', 'مرحباً')).toBe('https://wa.me/96170123456?text=%D9%85%D8%B1%D8%AD%D8%A8%D8%A7%D9%8B');
    expect(telLink('70123456')).toBe('tel:+96170123456');
    expect(waLink(null)).toBeNull();
  });
});
