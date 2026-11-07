/** CSV / Excel downloads for reports and the per-shop export. `xlsx` is loaded on demand so the POS bundle stays small. */

export type Row = Record<string, string | number | null | undefined>;

function download(blob: Blob, name: string) {
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

/** UTF-8 with BOM so Excel opens Arabic correctly. */
export function downloadCsv(name: string, rows: Row[]) {
  const cols = Array.from(rows.reduce((s, r) => { Object.keys(r).forEach(k => s.add(k)); return s; }, new Set<string>()));
  const esc = (v: unknown) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const text = [cols.join(','), ...rows.map(r => cols.map(c => esc(r[c])).join(','))].join('\r\n');
  download(new Blob(['﻿' + text], { type: 'text/csv;charset=utf-8' }), name.endsWith('.csv') ? name : `${name}.csv`);
}

/** One workbook, one sheet per entry. */
export async function downloadXlsx(name: string, sheets: Record<string, Row[]>) {
  const XLSX = await import('xlsx');
  const wb = XLSX.utils.book_new();
  for (const [title, rows] of Object.entries(sheets)) {
    const ws = XLSX.utils.json_to_sheet(rows.length ? rows : [{}]);
    XLSX.utils.book_append_sheet(wb, ws, title.slice(0, 31).replace(/[\\/?*[\]:]/g, ' '));
  }
  const out = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
  download(new Blob([out], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), name.endsWith('.xlsx') ? name : `${name}.xlsx`);
}

/** Flatten JSON rows (objects → JSON strings, keep scalars) so they fit a sheet. */
export function flat(rows: Record<string, unknown>[]): Row[] {
  return rows.map(r => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : (v as string | number)])));
}

export const usd = (cents: number) => Math.round(cents) / 100;
