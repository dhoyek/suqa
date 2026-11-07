import { NextResponse } from 'next/server';
import { verifyStandardWebhook } from '@/lib/server/standard-webhooks';
import { waSendText, waSendTemplate } from '@/lib/server/whatsapp';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Supabase Auth "Send SMS" hook → we deliver the OTP over WhatsApp instead of SMS.
// Supabase signs requests with the Standard Webhooks scheme; the secret (v1,whsec_…) is SUPABASE_SMS_HOOK_SECRET.
const verify = (raw: string, h: Headers) => verifyStandardWebhook(raw, h, process.env.SUPABASE_SMS_HOOK_SECRET);

export async function POST(req: Request) {
  const raw = await req.text();
  if (!verify(raw, req.headers)) return NextResponse.json({ error: 'bad signature' }, { status: 401 });
  const body = JSON.parse(raw) as { user?: { phone?: string; user_metadata?: Record<string, unknown> }; sms?: { otp?: string } };
  const phone = body.user?.phone?.replace(/^\+/, '');
  const otp = body.sms?.otp;
  if (!phone || !otp) return NextResponse.json({ error: 'missing phone or otp' }, { status: 400 });
  const brand = (body.user?.user_metadata?.brand as string) || 'Suqa';
  const text = `${otp} هو رمز الدخول إلى ${brand}. لا تشاركه مع أحد.\n${otp} is your ${brand} sign-in code. Don't share it.`;
  try {
    if (process.env.WHATSAPP_TEMPLATES === '1') {
      // Authentication template: body param = code, copy-code button param = code
      await waSendTemplate(phone, 'login_code', 'ar', [
        { type: 'body', parameters: [{ type: 'text', text: otp }] },
        { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: otp }] },
      ]).catch(async err => { console.warn('[sms-hook] template failed, sending text', (err as Error).message.slice(0, 160)); await waSendText(phone, text); });
    } else {
      await waSendText(phone, text);
    }
    return NextResponse.json({});
  } catch (e) {
    console.error('[sms-hook]', (e as Error).message);
    return NextResponse.json({ error: { http_code: 500, message: 'whatsapp delivery failed' } }, { status: 500 });
  }
}
