import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Shop backup file (schema 64): one JSON document, gzipped when the browser can —
 *   { version, at, shop, counts: [{ table, rows }], tables: { <table>: [row, …] } }
 * Tables are listed in restore order (parents before children). The backup is read page by page so it also works for a big shop;
 * the restore only ever ADDS rows that are missing (by primary key) — it never overwrites or deletes what is in the shop now.
 */
export type BackupHead = { version: number; at: string; shop: { id: string; name?: Record<string, string>; slug?: string } | null; tables: { table: string; rows: number }[] };
export type BackupFile = { version: number; at: string; shop: BackupHead['shop']; counts: { table: string; rows: number }[]; tables: Record<string, Record<string, unknown>[]> };
export type Progress = (p: { table: string; done: number; total: number }) => void;

const PAGE = 1000;
const CHUNK = 500;

export async function buildBackup(sb: SupabaseClient, shopId: string, onProgress?: Progress): Promise<{ blob: Blob; name: string; rows: number; at: string }> {
  const { data, error } = await sb.rpc('pos_backup_tables', { p_shop: shopId });
  if (error) throw error;
  const head = data as BackupHead;
  const total = head.tables.reduce((s, t) => s + Number(t.rows), 0);
  const parts: string[] = [`{"version":${head.version},"at":${JSON.stringify(head.at)},"shop":${JSON.stringify(head.shop)},"counts":${JSON.stringify(head.tables)},"tables":{`];
  let done = 0;
  for (let i = 0; i < head.tables.length; i++) {
    const t = head.tables[i].table;
    parts.push(`${i ? ',' : ''}${JSON.stringify(t)}:[`);
    let first = true;
    for (let off = 0; ; off += PAGE) {
      const r = await sb.rpc('pos_backup_page', { p_shop: shopId, p_table: t, p_offset: off, p_limit: PAGE });
      if (r.error) throw r.error;
      const rows = (r.data as unknown[]) ?? [];
      if (rows.length) { const s = JSON.stringify(rows); parts.push((first ? '' : ',') + s.slice(1, -1)); first = false; }
      done += rows.length; onProgress?.({ table: t, done, total });
      if (rows.length < PAGE) break;
    }
    parts.push(']');
  }
  parts.push('}}');
  const day = new Date(head.at).toISOString().slice(0, 10);
  const base = `suqa-backup-${head.shop?.slug || shopId.slice(0, 8)}-${day}.json`;
  const plain = new Blob(parts, { type: 'application/json' });
  if (typeof CompressionStream === 'undefined') return { blob: plain, name: base, rows: done, at: head.at };
  const gz = await new Response(plain.stream().pipeThrough(new CompressionStream('gzip'))).blob();
  return { blob: new Blob([gz], { type: 'application/gzip' }), name: `${base}.gz`, rows: done, at: head.at };
}

export function saveBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export async function readBackup(file: Blob): Promise<BackupFile> {
  const magic = new Uint8Array(await file.slice(0, 2).arrayBuffer());
  const gz = magic[0] === 0x1f && magic[1] === 0x8b;
  if (gz && typeof DecompressionStream === 'undefined') throw new Error('gzip_unsupported');
  const text = gz ? await new Response(file.stream().pipeThrough(new DecompressionStream('gzip'))).text() : await file.text();
  const j = JSON.parse(text) as BackupFile;
  if (!j || j.version !== 1 || !j.tables || typeof j.tables !== 'object' || !j.shop?.id) throw new Error('not_a_backup');
  return j;
}

/** Sends the file back table by table, in the order the file lists them. Returns how many rows were missing and are now back. */
export async function restoreBackup(sb: SupabaseClient, shopId: string, file: BackupFile, note: string, onProgress?: Progress): Promise<{ received: number; inserted: number }> {
  if (file.shop?.id !== shopId) throw new Error('other_shop');
  const order = (file.counts?.length ? file.counts.map(c => c.table) : Object.keys(file.tables)).filter(t => Array.isArray(file.tables[t]));
  const total = order.reduce((s, t) => s + file.tables[t].length, 0);
  let received = 0, inserted = 0;
  for (const t of order) {
    const rows = file.tables[t];
    for (let i = 0; i < rows.length; i += CHUNK) {
      const { data, error } = await sb.rpc('pos_restore_page', { p_shop: shopId, p_table: t, p_rows: rows.slice(i, i + CHUNK) });
      if (error) throw new Error(`${t}: ${error.message}`);
      const r = data as { received: number; inserted: number };
      received += r.received; inserted += r.inserted; onProgress?.({ table: t, done: received, total });
    }
  }
  const fin = await sb.rpc('pos_restore_finish', { p_shop: shopId, p_inserted: inserted, p_note: note });
  if (fin.error) throw fin.error;
  return { received, inserted };
}
