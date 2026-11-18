// Item search the way people type: Arabic, Arabizi ("man2ouche", "7alib"), English, small typos, and an item's aliases.
// The folding mirrors suqa.norm_text / suqa.skel_text (supabase/schema/75_item_matching.sql) — keep the two in step.

const AR_FROM = 'أإآٱةىؤئ٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹éèêëàâäçôöùûüîï';
const AR_TO = 'ااااهيوي01234567890123456789eeeeaaacoouuuii';
const tr = (s: string, from: string, to: string) => { let o = ''; for (const ch of s) { const i = from.indexOf(ch); o += i < 0 ? ch : to[i]; } return o; };

/** lower-case, no tashkeel, letter variants unified, Arabic-Indic digits → Western, punctuation → space */
export function normText(t: string | null | undefined): string {
  return tr((t ?? '').toLowerCase().replace(/[ً-ْـٰ]/g, ''), AR_FROM, AR_TO)
    .replace(/[^a-z0-9ء-يپچڤگ]+/g, ' ').trim();
}

/** one word → its consonant skeleton in a single alphabet: خبز = khebez = 5ebez → "xbz" */
function skelWord(word: string): string {
  let w = word.replace(/([^0-9])\1+/g, '$1');
  w = w.replace(/kh/g, 'X').replace(/sh/g, 'C').replace(/ch/g, 'C').replace(/gh/g, 'G').replace(/th/g, 'T').replace(/ph/g, 'F').replace(/ck/g, 'K');
  if (w.length > 2) w = w.replace(/[hه]$/, '');
  if (/[a-zA-Z]/.test(w) && !/[0-9]{2}/.test(w)) w = tr(w, '235789', 'KEXHGS');
  w = w.replace(/x/g, 'ks');
  w = tr(w, 'aeiouywpvcqXCGTFKHS', '~~~~~~~bfkkxcgtfkhs');
  w = tr(w, 'بتثجحخدذرزسشصضطظعغفقكلمنهپچڤگاويء', 'bttjhxddrzscsdtzEgfkklmnhbcfg~~~~');
  return w.replace(/~/g, '');
}
export const skelWords = (t: string | null | undefined): string[] => normText(t).split(' ').map(skelWord).filter(Boolean);

// one edit apart (a missing, extra or wrong letter): "mkc" ~ "mnkc"
function near(a: string, b: string): boolean {
  if (a === b) return true;
  const la = a.length, lb = b.length;
  if (Math.abs(la - lb) > 1) return false;
  let i = 0; while (i < la && i < lb && a[i] === b[i]) i++;
  let ea = la, eb = lb; while (ea > i && eb > i && a[ea - 1] === b[eb - 1]) { ea--; eb--; }
  return ea - i <= 1 && eb - i <= 1;
}

export type Folded = { norm: string; skels: string[] };
/** fold an item once (names, description, aliases …) */
export const foldItem = (...parts: (string | null | undefined)[]): Folded => { const all = parts.filter(Boolean).join(' '); return { norm: normText(all), skels: skelWords(all) }; };

/** a matcher for what the person typed; `null` when the box is empty */
export function makeMatcher(query: string): ((item: Folded) => boolean) | null {
  const qn = normText(query);
  if (!qn) return null;
  const toks = qn.split(' ').map(w => ({ w, s: skelWord(w), num: /^[0-9]+$/.test(w) }));
  return (item: Folded) => {
    if (item.norm.includes(qn)) return true;                                   // as typed
    return toks.every(t => {
      if (item.norm.includes(t.w)) return true;
      if (t.num) return false;                                                   // a size or count must be there as written
      if (t.s.length < 2) return t.w.length <= 2;                                // "w", "b", "el" join words and carry no weight; a longer word with no sound to compare ("mayy", "zzzz") must be there as typed
      if (t.s.length === 2) return item.skels.includes(t.s);                     // two sounds: the same word only ("bira" = بيرة, not "bread")
      return item.skels.some(k => k.startsWith(t.s) || near(k, t.s));
    });
  };
}
