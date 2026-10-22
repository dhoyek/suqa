import { NextResponse } from 'next/server';
import { timingSafeEqual } from 'node:crypto';
import { TEMPLATES } from '@/lib/server/wa-templates';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Operator endpoint: submit / inspect the WhatsApp message templates on the WABA.
// Auth: header x-suqa-secret = SUQA_EVENTS_SECRET. GET = status of our templates, POST = submit missing ones.
const GRAPH = 'https://graph.facebook.com/v21.0';

function authorized(req: Request) {
  const want = process.env.SUQA_EVENTS_SECRET, got = req.headers.get('x-suqa-secret');
  return !!want && !!got && want.length === got.length && timingSafeEqual(Buffer.from(want), Buffer.from(got));
}
const cfg = () => ({ waba: process.env.WHATSAPP_WABA_ID, token: process.env.WHATSAPP_TOKEN });

async function list() {
  const { waba, token } = cfg();
  const r = await fetch(`${GRAPH}/${waba}/message_templates?fields=name,status,language,category,rejected_reason&limit=100`, { headers: { authorization: `Bearer ${token}` } });
  const j = await r.json();
  if (!r.ok) throw new Error(JSON.stringify(j.error ?? j).slice(0, 400));
  return (j.data ?? []) as { name: string; status: string; language: string; category: string; rejected_reason?: string }[];
}

export async function GET(req: Request) {
  if (!authorized(req)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!cfg().waba || !cfg().token) return NextResponse.json({ error: 'WHATSAPP_WABA_ID / WHATSAPP_TOKEN missing' }, { status: 500 });
  try {
    const all = await list();
    const ours = new Set(TEMPLATES.map(t => t.name));
    return NextResponse.json({ templates: all.filter(t => ours.has(t.name)), templatesEnabled: process.env.WHATSAPP_TEMPLATES === '1' });
  } catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: 502 }); }
}

export async function POST(req: Request) {
  if (!authorized(req)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const { waba, token } = cfg();
  if (!waba || !token) return NextResponse.json({ error: 'WHATSAPP_WABA_ID / WHATSAPP_TOKEN missing' }, { status: 500 });
  let existing: Set<string>;
  try { existing = new Set((await list()).filter(t => t.language === 'ar').map(t => t.name)); }
  catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: 502 }); }

  const results: Record<string, unknown> = {};
  for (const t of TEMPLATES) {
    if (existing.has(t.name)) { results[t.name] = 'already exists'; continue; }
    const r = await fetch(`${GRAPH}/${waba}/message_templates`, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: t.name, language: 'ar', category: 'UTILITY', components: [{ type: 'BODY', text: t.body, example: { body_text: [t.samples] } }] }),
    });
    const j = await r.json();
    results[t.name] = r.ok ? { id: j.id, status: j.status, category: j.category } : { error: j.error?.error_user_msg ?? j.error?.message ?? j };
  }
  return NextResponse.json({ results });
}
