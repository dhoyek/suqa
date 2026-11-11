'use client';
import { useEffect, useState } from 'react';
import { num, text, type PosDb } from '@suqa/pos-core';
import type { L } from '../i18n';

/** One short line of items per order ("2× خبز عربي، 1 kg ليمون (مقطّع)"), read from the local mirror, for lists that show many orders. */
export function useOrderItems(db: PosDb, orderIds: string[], locale: L, enabled = true): Map<string, string> {
  const [m, setM] = useState<Map<string, string>>(new Map());
  const key = enabled ? orderIds.join(',') : '';
  useEffect(() => {
    if (!enabled || !orderIds.length) { setM(new Map()); return; }
    let on = true;
    db.orderLines.where('order_id').anyOf(orderIds).toArray().then(ls => {
      const out = new Map<string, string[]>();
      for (const l of ls) {
        if (l.voided) continue;
        const q = num(l.quantity); const u = l.unit ? ` ${l.unit} ` : '× ';
        (out.get(l.order_id) ?? out.set(l.order_id, []).get(l.order_id)!).push(`${q}${u}${text(l.name, locale)}${l.notes ? ` (${l.notes})` : ''}`);
      }
      if (on) setM(new Map([...out].map(([k, v]) => [k, v.join('، ')])));
    });
    return () => { on = false; };
  }, [db, key, locale]); // eslint-disable-line react-hooks/exhaustive-deps
  return m;
}
