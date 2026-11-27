'use client';
import { useEffect, useRef, useState, type CSSProperties } from 'react';

/** "1,5" and "١٫٥" are numbers too: Arabic digits and a comma as the decimal sign become what Number() reads. */
export const toNumText = (s: string) => s.replace(/[٠-٩]/g, d => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d))).replace(/[,٫]/g, '.').replace(/[^\d.]/g, '').replace(/^(\d*\.\d*).*$/, '$1');

/**
 * A number box that lets a decimal be TYPED. A box tied straight to a number loses the "." the moment it is typed ("1." is the
 * number 1), so 1.5 could never be entered. This one keeps the text as typed and hands the number up; it takes a new value from
 * outside only when that value is not what the text already says (a chip that fills the price, a row loaded from a photo).
 */
export default function NumInput({ value, onChange, empty = false, className = 'input', style, placeholder, title }: {
  value: number | null | undefined; onChange: (n: number | null) => void; /** an empty box means "no value" (null) instead of 0 */ empty?: boolean;
  className?: string; style?: CSSProperties; placeholder?: string; title?: string;
}) {
  const show = (v: number | null | undefined) => (v == null || (empty && !Number.isFinite(v)) ? '' : String(v));
  const [txt, setTxt] = useState(() => show(value)); const mine = useRef<number | null>(value ?? null);
  useEffect(() => { const v = value ?? null; if (v !== mine.current) { mine.current = v; setTxt(show(v)); } }, [value]);   // eslint-disable-line react-hooks/exhaustive-deps
  return <input className={className} dir="ltr" inputMode="decimal" style={style} placeholder={placeholder} title={title} value={txt}
    onFocus={e => e.target.select()}
    onChange={e => { const t = toNumText(e.target.value); setTxt(t); const n = t === '' || t === '.' ? (empty ? null : 0) : Number(t); const out = n != null && Number.isFinite(n) ? n : empty ? null : 0; mine.current = out; onChange(out); }} />;
}
