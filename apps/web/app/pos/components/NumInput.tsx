'use client';
import { useEffect, useRef, useState, type CSSProperties } from 'react';

/** "1,5" and "١٫٥" are numbers too: Arabic digits and a comma as the decimal sign become what Number() reads. */
export const toNumText = (s: string) => s.replace(/[٠-٩]/g, d => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d))).replace(/[,٫]/g, '.').replace(/[^\d.]/g, '').replace(/^(\d*\.\d*).*$/, '$1');

/**
 * A number box that lets a decimal be TYPED. A box tied straight to a number loses the "." the moment it is typed ("1." is the
 * number 1), so 1.5 could never be entered. This one keeps the text as typed and hands the number up; it takes a new value from
 * outside only when that value is not what the text already says (a chip that fills the price, a row loaded from a photo).
 */
export default function NumInput({ value, onChange, empty = false, className = 'input', style, placeholder, title, disabled }: {
  value: number | null | undefined; onChange: (n: number | null) => void; /** an empty box means "no value" (null) instead of 0 */ empty?: boolean;
  className?: string; style?: CSSProperties; placeholder?: string; title?: string; disabled?: boolean;
}) {
  const show = (v: number | null | undefined) => (v == null || (empty && !Number.isFinite(v)) ? '' : String(v));
  const [txt, setTxt] = useState(() => show(value)); const mine = useRef<number | null>(value ?? null);
  // While the box is being typed in, the text stays the person's: a caller that rounds or limits the number (a whole-unit item, a
  // minimum) must not rewrite "0." on the way to "0.5". The caller's figure is shown when the box is left.
  const focused = useRef(false);
  useEffect(() => { const v = value ?? null; if (v !== mine.current) { mine.current = v; if (!focused.current) setTxt(show(v)); } }, [value]);   // eslint-disable-line react-hooks/exhaustive-deps
  return <input className={className} dir="ltr" inputMode="decimal" style={style} placeholder={placeholder} title={title} value={txt}
    disabled={disabled} onFocus={e => { focused.current = true; e.target.select(); }} onBlur={() => { focused.current = false; setTxt(show(value)); }}
    onChange={e => { const t = toNumText(e.target.value); setTxt(t); const n = t === '' || t === '.' ? (empty ? null : 0) : Number(t); const out = n != null && Number.isFinite(n) ? n : empty ? null : 0; mine.current = out; onChange(out); }} />;
}
