// Item search the way people type: Arabic, Arabizi ("man2ouche", "7alib"), English, small typos, and an item's aliases.
// The folding mirrors suqa.norm_text / suqa.skel_text (supabase/schema/75_item_matching.sql) — keep the two in step.

import { CONCEPTS } from './concepts';

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
  if (Math.abs(la - lb) > 1 || Math.max(la, lb) < 4) return false;        // three sounds differ too easily by one ("bread" brd / "baladi" bld)
  let i = 0; while (i < la && i < lb && a[i] === b[i]) i++;
  let ea = la, eb = lb; while (ea > i && eb > i && a[ea - 1] === b[eb - 1]) { ea--; eb--; }
  return ea - i <= 1 && eb - i <= 1;
}

export type Folded = { norm: string; skels: string[] };
/** fold an item once (names, description, aliases …) */
export const foldItem = (...parts: (string | null | undefined)[]): Folded => { const all = parts.filter(Boolean).join(' '); return { norm: normText(all), skels: skelWords(all) }; };

// ---- kinds of item (concepts.ts): "machroub" finds every drink, "machroub pepsi" the Pepsi ----
type Kind = { say: { n: string; s: string | null }[]; tags: string[] };
let kinds: Kind[] | null = null;
const getKinds = (): Kind[] => kinds ??= CONCEPTS.map(c => ({
  // by sound only towards the Arabic-script names (as in 84): "machroub" = مشروب, while "galaxy" is not "glaces"
  say: c.say.map(w => { const n = normText(w); const sk = n.includes(' ') || !/[ء-ي]/.test(n) ? null : skelWord(n); return { n, s: sk && sk.length >= 3 ? sk : null }; }).filter(x => x.n),
  tags: c.tags.map(normText).filter(Boolean),
}));
/** does an item's folded text carry one of these tags? short tags only as whole words, longer ones at the start of a word */
export const hasTag = (norm: string, tags: string[]): boolean => {
  const t = ` ${norm} `;
  return tags.some(g => g.replace(/ /g, '').length <= 4 ? t.includes(` ${g} `) : t.includes(` ${g}`));
};
// by sound: the same word, or with one more sound at the end ("machroubet" = machroub + t, "chipset")
const sameKindWord = (w: string, say: string) => w === say || (w.startsWith(say) && w.length - say.length <= 1);
/** the words of a search that name a kind of item, and the tags of those kinds; the other words are left as typed */
export function kindsIn(qn: string): { words: Map<number, string[]>; rest: string[] } {
  const ws = qn.split(' ').filter(Boolean); const words = new Map<number, string[]>();
  for (const k of getKinds()) {
    for (const s of k.say) {
      if (s.n.includes(' ')) {                                                   // "soft drink", "ice cream": the words in a row
        const sw = s.n.split(' ');
        for (let i = 0; i + sw.length <= ws.length; i++) if (sw.every((w, j) => ws[i + j] === w)) sw.forEach((_, j) => words.set(i + j, [...(words.get(i + j) ?? []), ...k.tags]));
      } else ws.forEach((w, i) => { if (w === s.n || (s.s && sameKindWord(skelWord(w), s.s))) words.set(i, [...(words.get(i) ?? []), ...k.tags]); });
    }
  }
  return { words, rest: ws.filter((_, i) => !words.has(i)) };
}

/** a matcher for what the person typed; `null` when the box is empty */
export function makeMatcher(query: string): ((item: Folded) => boolean) | null {
  const qn = normText(query);
  if (!qn) return null;
  const { words: kindWords } = kindsIn(qn);
  const toks = qn.split(' ').map((w, i) => ({ w, s: skelWord(w), num: /^[0-9]+$/.test(w), tags: kindWords.get(i) ?? null }));
  return (item: Folded) => {
    if (item.norm.includes(qn)) return true;                                   // as typed
    return toks.every(t => {
      if (item.norm.includes(t.w)) return true;
      if (t.tags && hasTag(item.norm, t.tags)) return true;                      // the word names a kind of item, and this item is of that kind
      if (t.num) return false;                                                   // a size or count must be there as written
      if (t.s.length < 2) return t.w.length <= 2;                                // "w", "b", "el" join words and carry no weight; a longer word with no sound to compare ("mayy", "zzzz") must be there as typed
      if (t.s.length === 2) return item.skels.includes(t.s);                     // two sounds: the same word only ("bira" = بيرة, not "bread")
      return item.skels.some(k => k.startsWith(t.s) || (k.length >= 3 && near(k, t.s)));    // a typo is forgiven between real words, not against a two-sound one ("bebsi" is not "pies")
    });
  };
}
