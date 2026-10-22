import { NextResponse } from 'next/server';
import { timingSafeEqual } from 'node:crypto';
import { TEMPLATES } from '@/lib/server/wa-templates';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const GRAPH = 'https://graph.facebook.com/v21.0';

// Operator tool: GET = status of our templates in Meta, POST = submit any that are missing.
// Protected by the shared SUQA_EVENTS_SECRET (x-suqa-secret header). Needs WHATSAPP_WABA_ID + WHATSAPP_TOKEN.
function authorized(req: Request) {
  const want = process.env.SUQA_EVENTS_SECRET, got = req.headers.get('x-suqa-secret');
  return !!want && !!got && want.length === got.length && timingSafeEqual(Buffer.from(want), Buffer.from(got));
}
const auth = () => ({ authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` });

async function existing() {
  const res = await fetch(`${GRAPH}/${process.env.WHATSAPP_WABA_ID}/message_templates?fields=name,language,status,category,rejected_reason&limit=200`, { headers: auth() });
  const json = await res.json();
  if (!res.ok) throw new Error(JSON.stringify(json.error ?? json).slice(0, 400));
  return (json.data ?? []) as { name: string; language: string; status: string; category: string; rejected_reason?: string }[];
}

export async function GET(req: Request) {
  if (!authorized(req)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  try {
    const all = await existing();
    return NextResponse.json(all.filter(t => TEMPLATES.some(d => d.name === t.name)));
  } catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: 500 }); }
}

export async function POST(req: Request) {
  if (!authorized(req)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!process.env.WHATSAPP_WABA_ID || !process.env.WHATSAPP_TOKEN) return NextResponse.json({ error: 'WHATSAPP_WABA_ID / WHATSAPP_TOKEN missing' }, { status: 500 });
  const have = await existing().catch(() => []);
  const results: Record<string, unknown> = {};
  for (const d of TEMPLATES) {
    if (have.some(t => t.name === d.name && t.language === d.language)) { results[d.name] = 'exists'; continue; }
    const res = await fetch(`${GRAPH}/${process.env.WHATSAPP_WABA_ID}/message_templates`, {
      method: 'POST', headers: { ...auth(), 'content-type': 'application/json' },
      body: JSON.stringify({ name: d.name, language: d.language, category: d.category, components: [{ type: 'BODY', text: d.text, example: { body_text: [d.samples] } }] }),
    });
    const json = await res.json().catch(() => ({}));
    results[d.name] = res.ok ? json : { error: json.error?.error_user_msg ?? json.error?.message ?? json };
  }
  return NextResponse.json(results);
}
