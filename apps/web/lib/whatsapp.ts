// WhatsApp deep links. Numbers are normalised to digits only (wa.me wants no "+").
// Lebanese local numbers (03 123 456 / 70 123 456) are expanded to +961.

export function normalizePhone(raw: string | null | undefined, defaultCountry = '961'): string | null {
  if (!raw) return null;
  let d = raw.replace(/[^\d+]/g, '');
  if (d.startsWith('+')) d = d.slice(1);
  else if (d.startsWith('00')) d = d.slice(2);
  else if (d.startsWith('0')) d = defaultCountry + d.slice(1);
  else if (d.length <= 8) d = defaultCountry + d;
  return d.length >= 8 ? d : null;
}

export function waLink(number: string | null | undefined, text?: string): string | null {
  const n = normalizePhone(number);
  if (!n) return null;
  return `https://wa.me/${n}${text ? `?text=${encodeURIComponent(text)}` : ''}`;
}

export function telLink(number: string | null | undefined): string | null {
  const n = normalizePhone(number);
  return n ? `tel:+${n}` : null;
}
