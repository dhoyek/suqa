import { NextResponse } from 'next/server';
import * as XLSX from 'xlsx';
import { getUser } from '@/lib/auth';
import { supabaseServer } from '@/lib/supabase-server';
import { ADAPTERS, pickAdapter, type Mapping, type RawRow } from '@/lib/server/import-adapters';

// Catalog import, two steps, both owner-only (the RPC checks the role again):
//   POST multipart {file, shop_id}                       → parse xlsx/csv: headers, rows, suggested mapping, adapter id
//   POST json {shop_id, adapter, mapping, rows, dry_run} → convert with the adapter and call pos_import_products
export const runtime = 'nodejs';
export const maxDuration = 60;

export async function POST(req: Request) {
  const user = await getUser();
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const ct = req.headers.get('content-type') ?? '';

  if (ct.includes('multipart/form-data')) {
    const form = await req.formData();
    const file = form.get('file');
    if (!(file instanceof File)) return NextResponse.json({ error: 'no_file' }, { status: 400 });
    if (file.size > 10 * 1024 * 1024) return NextResponse.json({ error: 'too_large' }, { status: 413 });
    const buf = Buffer.from(await file.arrayBuffer());
    const wb = XLSX.read(buf, { type: 'buffer', raw: false, cellDates: false });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json<RawRow>(ws, { defval: '' });
    const headers = rows.length ? Object.keys(rows[0]) : (XLSX.utils.sheet_to_json<string[]>(ws, { header: 1 })[0] ?? []).map(String);
    const adapter = pickAdapter(headers);
    return NextResponse.json({ headers, rows: rows.slice(0, 5000), total: rows.length, sheet: wb.SheetNames[0], adapter: adapter.id, mapping: adapter.suggest(headers), adapters: ADAPTERS.map(a => ({ id: a.id, label: a.label })) });
  }

  const body = await req.json().catch(() => null) as { shop_id?: string; adapter?: string; mapping?: Mapping; rows?: RawRow[]; dry_run?: boolean } | null;
  if (!body?.shop_id || !Array.isArray(body.rows)) return NextResponse.json({ error: 'bad_request' }, { status: 400 });
  const adapter = ADAPTERS.find(a => a.id === body.adapter) ?? ADAPTERS[0];
  const converted = body.rows.map((r, i) => ({ i: i + 1, row: adapter.convert(r, body.mapping ?? {}) })).filter(x => x.row);
  const sb = await supabaseServer();
  const { data, error } = await sb.rpc('pos_import_products', { p_shop: body.shop_id, p_rows: converted.map(x => x.row), p_dry_run: body.dry_run !== false });
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  // map RPC row indexes (1-based over converted rows) back to source line numbers
  const res = data as { rows: Array<{ i: number; action: string; message?: string | null }>; created: number; updated: number; errors: number; dry_run: boolean };
  res.rows = res.rows.map(r => ({ ...r, i: converted[r.i - 1]?.i ?? r.i }));
  return NextResponse.json({ ...res, skipped: body.rows.length - converted.length });
}
