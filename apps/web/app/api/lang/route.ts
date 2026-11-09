import { NextResponse } from 'next/server';
import { LANG_COOKIE } from '@/lib/locale';

export const dynamic = 'force-dynamic';

/** POST (form) lang=ar|en & next=/path → sets the language cookie for a year and goes back. */
export async function POST(req: Request) {
  const form = await req.formData();
  const lang = String(form.get('lang') ?? ''); const next = String(form.get('next') ?? '/');
  const res = NextResponse.redirect(new URL(next.startsWith('/') ? next : '/', req.url), 303);
  if (lang === 'ar' || lang === 'en') res.cookies.set(LANG_COOKIE, lang, { path: '/', maxAge: 60 * 60 * 24 * 365, sameSite: 'lax' });
  return res;
}
