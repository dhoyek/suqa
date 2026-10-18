import { describe, it, expect, vi } from 'vitest';
import { createHmac } from 'node:crypto';

vi.mock('server-only', () => ({}));
const { waVerifySignature } = await import('../server/whatsapp');

describe('waVerifySignature', () => {
  const body = '{"object":"whatsapp_business_account"}';
  it('accepts a valid sha256 signature', () => {
    process.env.WHATSAPP_APP_SECRET = 'secret';
    const sig = 'sha256=' + createHmac('sha256', 'secret').update(body).digest('hex');
    expect(waVerifySignature(body, sig)).toBe(true);
  });
  it('rejects a wrong or missing signature', () => {
    process.env.WHATSAPP_APP_SECRET = 'secret';
    expect(waVerifySignature(body, 'sha256=' + '0'.repeat(64))).toBe(false);
    expect(waVerifySignature(body, null)).toBe(false);
    expect(waVerifySignature(body, 'md5=abc')).toBe(false);
  });
  it('passes through when no app secret is configured (dev)', () => {
    delete process.env.WHATSAPP_APP_SECRET;
    expect(waVerifySignature(body, null)).toBe(true);
  });
});
