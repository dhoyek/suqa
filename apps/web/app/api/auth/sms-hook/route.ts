import { NextResponse } from 'next/server';
import { verifyStandardWebhook } from '@/lib/server/standard-webhooks';
import { waSendText } from '@/lib/server/whatsapp';

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
  try {
    await waSendText(phone, `${otp} هو رمز الدخول إلى ${brand}. لا تشاركه مع أحد.\n${otp} is your ${brand} sign-in code. Don't share it.`);
    return NextResponse.json({});
  } catch (e) {
    console.error('[sms-hook]', (e as Error).message);
    return NextResponse.json({ error: { http_code: 500, message: 'whatsapp delivery failed' } }, { status: 500 });
  }
}
