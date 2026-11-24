// Item search the way people type: Arabic, Arabizi ("man2ouche", "7alib"), English, small typos, and an item's aliases.
// The folding mirrors suqa.norm_text / suqa.skel_text (supabase/schema/75_item_matching.sql) — keep the two in step.

import { CONCEPTS, notInOf } from './concepts';

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

export type Folded = { norm: string; skels: string[]; section?: string | null };      // section: the item's category key, when the caller knows it (97: a kind never matches in some categories)
/** fold an item once (names, description, aliases …) */
export const foldItem = (...parts: (string | null | undefined)[]): Folded => { const all = parts.filter(Boolean).join(' '); return { norm: normText(all), skels: skelWords(all) }; };

// ---- kinds of item (concepts.ts): "machroub" finds every drink, "machroub pepsi" the Pepsi ----
type Tag = { t: string; whole: boolean };
type Kind = { say: { n: string; s: string | null }[]; tags: Tag[]; not: Tag[]; notIn: Set<string> };
const tagOf = (raw: string): Tag & { neg: boolean } => {
  const neg = raw.startsWith('-'), eq = raw.replace(/^-/, '').startsWith('='); const t = normText(raw.replace(/^[-=]+/, ''));
  return { t, neg, whole: eq || t.replace(/ /g, '').length <= 4 };
};
let kinds: Kind[] | null = null;
const getKinds = (): Kind[] => kinds ??= CONCEPTS.map(c => {
  const tags = c.tags.map(tagOf).filter(x => x.t);
  return {
    // by sound only towards the Arabic-script names (as in 84): "machroub" = مشروب, while "galaxy" is not "glaces"
    say: c.say.map(w => { const n = normText(w); const sk = n.includes(' ') || !/[ء-ي]/.test(n) ? null : skelWord(n); return { n, s: sk && sk.length >= 3 ? sk : null }; }).filter(x => x.n),
    tags: tags.filter(x => !x.neg), not: tags.filter(x => x.neg), notIn: new Set(notInOf(c)),
  };
});
const tagIn = (t: string, g: Tag) => (g.whole ? t.includes(` ${g.t} `) : t.includes(` ${g.t}`));
/** is an item (its folded names, aliases and section) of one of these kinds? */
export const ofKind = (norm: string, ks: Kind[], section?: string | null): boolean => {
  const t = ` ${norm} `;
  return ks.some(k => !(section && k.notIn.has(section)) && k.tags.some(g => tagIn(t, g)) && !k.not.some(g => tagIn(t, g)));
};
// by sound: the same word, or with one more sound at the end ("machroubet" = machroub + t)
const sameKindWord = (w: string, say: string) => w === say || (w.startsWith(say) && w.length - say.length <= 1);
/** the words of a search that name a kind of item, and the tags of those kinds; the other words are left as typed */
export function kindsIn(qn: string): { words: Map<number, Kind[]>; rest: string[] } {
  const ws = qn.split(' ').filter(Boolean); const words = new Map<number, Kind[]>();
  for (const k of getKinds()) {
    for (const s of k.say) {
      if (s.n.includes(' ')) {                                                   // "soft drink", "ice cream": the words in a row
        const sw = s.n.split(' ');
        for (let i = 0; i + sw.length <= ws.length; i++) if (sw.every((w, j) => ws[i + j] === w)) sw.forEach((_, j) => words.set(i + j, [...(words.get(i + j) ?? []), k]));
      } else ws.forEach((w, i) => { if (w === s.n || (s.s && sameKindWord(skelWord(w), s.s))) words.set(i, [...(words.get(i) ?? []), k]); });
    }
  }
  return { words, rest: ws.filter((_, i) => !words.has(i)) };
}

/** a matcher for what the person typed; `null` when the box is empty */
export function makeMatcher(query: string): ((item: Folded) => boolean) | null {
  const qn = normText(query);
  if (!qn) return null;
  const { words: kindWords } = kindsIn(qn);
  const toks = qn.split(' ').map((w, i) => ({ w, s: skelWord(w), num: /^[0-9]+$/.test(w), kinds: kindWords.get(i) ?? null }));
  return (item: Folded) => {
    if (!kindWords.size && item.norm.includes(qn)) return true;                // as typed
    return toks.every(t => {
      // a word that names a kind of item: the items of that kind, or that word itself — no guessing by sound ("may" is not "mayonnaise")
      if (t.kinds) return ` ${item.norm} `.includes(` ${t.w} `) || ofKind(item.norm, t.kinds, item.section);
      if (item.norm.includes(t.w)) return true;
      if (t.num) return false;                                                   // a size or count must be there as written
      if (t.s.length < 2) return t.w.length <= 2;                                // "w", "b", "el" join words and carry no weight; a longer word with no sound to compare ("mayy", "zzzz") must be there as typed
      if (t.s.length === 2) return item.skels.includes(t.s);                     // two sounds: the same word only ("bira" = بيرة, not "bread")
      return item.skels.some(k => k.startsWith(t.s) || (k.length >= 3 && near(k, t.s)));    // a typo is forgiven between real words, not against a two-sound one ("bebsi" is not "pies")
    });
  };
}

// ---- a shop page's search box: what was typed first, then the same word in the other alphabet, a typo only as a last resort ----
// makeMatcher alone forgives too much for a list that is filtered as the person types: "panten" brought the whole "Pantry"
// category (a category name compared by sound) and the peanuts ("bnt" is one sound away from "bntn"), and "pepsi" brought
// "pops". Here a word matches, in this order of trust:
//   1. as typed, anywhere in the item's text (names, description, other names, category);
//   2. by sound against a NAME word written in the OTHER alphabet ("tawouk" = طاووق, "بانتين" = Pantene) — never against a
//      category name, and never between two words of the same alphabet ("pepsi" is not "pops");
//   3. only when nothing in the shop matched 1 or 2: the forgiving matcher (typos, same-alphabet sounds), as before.
// A word that names a kind of item ("machroub", "chokola") keeps the kind rules of makeMatcher.
type NameWord = { s: string; w: string; ar: boolean };
export type SearchFold = Folded & { words: NameWord[] };
const isAr = (w: string) => /[ء-يپچڤگ]/.test(w);
/** fold an item for searchItems: `names` are compared by sound, `extra` (category names …) only as typed */
export function foldForSearch(names: (string | null | undefined)[], extra: (string | null | undefined)[] = [], section?: string | null): SearchFold {
  const n = names.filter(Boolean).join(' ');
  const words = normText(n).split(' ').filter(Boolean).map(w => ({ w, s: skelWord(w), ar: isAr(w) })).filter(x => x.s);
  return { norm: normText([n, ...extra.filter(Boolean)].join(' ')), skels: words.map(x => x.s), words, section: section ?? null };
}
// A long vowel written inside the Arabic word must be heard in the Latin one: بوبس ("pops") is not "pepsi", بيبسي is.
// The last letter is left out (شامبو = "shampa" in speech), and so is a first و / ي, which is a consonant there.
const vowelsAgree = (latin: string, arabic: string): boolean => {
  for (let i = 1; i < arabic.length - 1; i++) {
    if (arabic[i] === 'و' && !/[ouw]/.test(latin)) return false;
    if (arabic[i] === 'ي' && !/[iey]/.test(latin)) return false;
  }
  return true;
};
/** the items a shop page shows for what was typed; everything when the box is empty */
export function searchItems<T>(items: T[], foldOf: (item: T) => SearchFold, query: string): T[] {
  const qn = normText(query);
  if (!qn) return items;
  const loose = makeMatcher(query)!;
  if (kindsIn(qn).words.size) return items.filter(x => loose(foldOf(x)));
  const toks = qn.split(' ').filter(Boolean).map(w => ({ w, s: skelWord(w), ar: isAr(w), num: /^[0-9]+$/.test(w) }));
  const strong = (f: SearchFold) => f.norm.includes(qn) || toks.every(t => {
    if (f.norm.includes(t.w)) return true;
    if (t.num) return false;
    if (t.s.length < 2) return toks.length > 1 && t.w.length <= 2;              // "w", "el" between other words carry no weight
    return f.words.some(k => k.ar !== t.ar && (t.s.length === 2 ? k.s === t.s : k.s.startsWith(t.s)) && (t.ar ? vowelsAgree(k.w, t.w) : vowelsAgree(t.w, k.w)));
  });
  const sure = items.filter(x => strong(foldOf(x)));
  return sure.length ? sure : items.filter(x => loose(foldOf(x)));
}
