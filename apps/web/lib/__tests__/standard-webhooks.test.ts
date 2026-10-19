import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import { verifyStandardWebhook } from '../server/standard-webhooks';

const keyB64 = Buffer.from('0123456789abcdef0123456789abcdef').toString('base64');
const secret = `v1,whsec_${keyB64}`;
const body = '{"user":{"phone":"96170483148"},"sms":{"otp":"123456"}}';
const now = 1_760_000_000_000;
const ts = String(Math.floor(now / 1000));
const sign = (k: string, id = 'msg_1') => 'v1,' + createHmac('sha256', Buffer.from(k, 'base64')).update(`${id}.${ts}.${body}`).digest('base64');
const headers = (sig: string) => new Headers({ 'webhook-id': 'msg_1', 'webhook-timestamp': ts, 'webhook-signature': sig });

describe('verifyStandardWebhook', () => {
  it('accepts a valid signature', () => expect(verifyStandardWebhook(body, headers(sign(keyB64)), secret, now)).toBe(true));
  it('accepts when one of several signatures matches', () => expect(verifyStandardWebhook(body, headers('v1,AAAA ' + sign(keyB64)), secret, now)).toBe(true));
  it('rejects a wrong key', () => expect(verifyStandardWebhook(body, headers(sign(Buffer.from('x'.repeat(32)).toString('base64'))), secret, now)).toBe(false));
  it('rejects a tampered body', () => expect(verifyStandardWebhook(body + ' ', headers(sign(keyB64)), secret, now)).toBe(false));
  it('rejects an old timestamp', () => expect(verifyStandardWebhook(body, headers(sign(keyB64)), secret, now + 10 * 60 * 1000)).toBe(false));
  it('rejects when no secret is configured', () => expect(verifyStandardWebhook(body, headers(sign(keyB64)), undefined, now)).toBe(false));
});
