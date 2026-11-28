import { describe, expect, it, test } from 'vitest';
import { CatalogIndex } from './catalog';
import { foldForSearch, foldItem, makeMatcher, searchItems, skelWords } from './item-match';
test('folding matches SQL', () => {
  expect(skelWords('خبز')).toEqual(['xbz']); expect(skelWords('khebez')).toEqual(['xbz']); expect(skelWords('5ebez')).toEqual(['xbz']);
  expect(skelWords('منقوشة')).toEqual(['mnkc']); expect(skelWords('man2ouche')).toEqual(['mnkc']);
  expect(skelWords('PEPSI MAX 185ML CAN')).toEqual(['bbs', 'mks', '185ml', 'kn']); expect(skelWords('قهوة')).toEqual(['kh']); expect(skelWords('2ahwe')).toEqual(['kh']);
  expect(skelWords('حمّص')).toEqual(['hms']); expect(skelWords('7ommos')).toEqual(['hms']); expect(skelWords('labneh')).toEqual(['lbn']);
});
test('search', () => {
  const z = foldItem('زعتر', 'Zaatar', 'منقوشة', 'man2ouche'), w = foldItem('مياه', 'Water', 'mayy', 'may'), k = foldItem('كعكة بالشوكولا', 'Kaak with chocolate'), p = foldItem('بيبسي ماكس تنك 185 مل', 'PEPSI MAX 185ML CAN');
  const m = (q: string) => makeMatcher(q)!;
  for (const q of ['ma2ouche', 'man2ouche', 'mankoushe', 'منقوشة', 'za3tar', 'zaatar', 'man2ouche za3tar', 'زعتر']) expect(m(q)(z), q).toBe(true);
  expect(m('mayy')(w)).toBe(true); expect(m('man2ouche')(w)).toBe(false); expect(m('ka3ke chocola')(k)).toBe(true); expect(m('bebsi')(p)).toBe(true); expect(m('pepsi 330')(p)).toBe(false); expect(m('pepsi 185')(p)).toBe(true);
  expect(m('zaatar')(k)).toBe(false);
  const beer = foldItem('بيرة', 'Beer', 'bira'), bread = foldItem('رغيف', 'Bread loaf');
  expect(m('bebsi')(foldItem('دجاج بالعجين', 'Chicken in dough', 'Dough Pies & Pizza'))).toBe(false);
  expect(m('bira')(beer)).toBe(true); expect(m('bira')(bread)).toBe(false); expect(m('zzzz')(bread)).toBe(false); expect(m('mayy')(bread)).toBe(false);
  expect(m('za3tar w jebne')(foldItem('زعتر + جبنة', 'Zaatar + cheese'))).toBe(true); expect(m('za3tar w jebne')(z)).toBe(false);
});

test('POS catalog search: exact first, then Arabizi / alias / typo, all offline', () => {
  const mk = (id: string, ar: string, en: string, aliases: string[] = []) => ({ id, tenant_id: 't', shop_id: 's', name: { ar, en }, aliases, price_usd: 1, price_currency: 'usd', price_lbp: 0, unit_kind: 'piece', decimal_qty: false, vat: false, track_stock: false, min_stock: 0, visible_online: true, is_available: true, is_active: true, sort_order: 0, on_hand: 0, reserved: 0, section: null }) as never;
  const ix = new CatalogIndex();
  ix.load([mk('1', 'زعتر', 'Zaatar', ['man2ouche']), mk('2', 'مياه', 'Water', ['mayy']), mk('3', 'خبز عربي', 'Arabic bread'), mk('4', 'بيبسي', 'Pepsi')], [], [], []);
  const names = (q: string) => ix.search(q).map(p => p.name.en);
  expect(names('ma2ouche')).toEqual(['Zaatar']); expect(names('mayy')).toEqual(['Water']); expect(names('khebez')).toEqual(['Arabic bread']); expect(names('bebsi')).toEqual(['Pepsi']);
  expect(names('pepsi')).toEqual(['Pepsi']); expect(names('zzzz')).toEqual([]);
});

test('kinds of item (84): "machroub" finds the drinks by their section, "miyah" the water', () => {
  const pepsi = foldItem('بيبسي 2 ل', 'PEPSI 2L', 'SYRO JUS/SOFTDR'), jallab = foldItem('جلاب', 'JALLAB', 'SYRO JUS/SOFTDR'), water = foldItem('مياه ٦×١٫٥ ل', 'WATER 6x1.5L', 'WATER');
  const milk = foldItem('روني حليب', 'RONI MILK', 'CHOBISC/GUM/BON'), choc = foldItem('روني شوكولا', 'RONI CHOCLT', 'CHOBISC/GUM/BON'), clean = foldItem('منظف أرض', 'FLOOR CLEANER', 'DETERG/ANTISEPT');
  const m = (q: string) => makeMatcher(q)!;
  for (const q of ['machroub', 'mashroub', 'machroubet', 'مشروبات', 'drinks']) {
    expect([pepsi, jallab, water].every(m(q)), q).toBe(true); expect([milk, choc, clean].some(m(q)), q).toBe(false);
  }
  expect(m('machroub pepsi')(pepsi)).toBe(true); expect(m('machroub pepsi')(jallab)).toBe(false);
  for (const q of ['miyah', 'may', 'mayye']) { expect(m(q)(water), q).toBe(true); expect(m(q)(milk), q).toBe(false); }
  expect(m('chokola')(choc)).toBe(true); expect(m('tandif')(clean)).toBe(true);
  expect(m('galaxy')(foldItem('GIANT CHOCOLATE ICE CREAM', 'ICE CREAM'))).toBe(false);
});

test('the kinds of item are the same in the till and in the database (84)', async () => {
  const { readFileSync } = await import('node:fs');
  const { CONCEPTS } = await import('./concepts');
  const sql = ['84_category_matching.sql', '122_hookah_kind.sql'].map(f => readFileSync(new URL(`../../../supabase/schema/${f}`, import.meta.url), 'utf8')).join('\n');
  const lit = (a: string[]) => `array[${a.map(x => `'${x.replace(/'/g, "''")}'`).join(', ')}]`;
  for (const c of CONCEPTS) expect(sql.includes(`('${c.id}',\n   ${lit(c.say)},\n   ${lit(c.tags)})`), c.id).toBe(true);
});

test('kinds: whole words and exclusions ("may" is not mayonnaise, tuna in water is not water)', () => {
  const m = (q: string) => makeMatcher(q)!;
  expect(m('may')(foldItem('مايونيز', 'Mayonnaise'))).toBe(false);
  expect(m('miyah')(foldItem('تونا بالماء', 'Tuna in water'))).toBe(false);
  expect(m('miyah')(foldItem('فيب بطيخ', 'vape watermalon', 'AIR REFRESHNING'))).toBe(false);
  expect(m('machroub')(foldItem('فيب بطيخ', 'vape watermalon', 'AIR REFRESHNING'))).toBe(false);
  expect(m('chokola')(foldItem('فواكه مشكّلة', 'fweke mchakale', 'AIR REFRESHNING'))).toBe(false);
  expect(m('miyah')(foldItem('تنورين 1.5 ل', 'Tannourine 1.5L', 'WATER'))).toBe(true);
});

test('"machroub" is soft drinks, not alcohol', () => {
  const m = (q: string) => makeMatcher(q)!;
  expect(m('machroub')(foldItem('بيرة ألمازة 50 سل', 'Almaza beer', 'ALCOOL مشروبات روحية'))).toBe(false);
  expect(m('bira')(foldItem('بيرة ألمازة 50 سل', 'Almaza beer', 'ALCOOL'))).toBe(true);
});

test('a kind never matches in a category it cannot belong to (97); a name still matches anywhere', () => {
  const m = (q: string) => makeMatcher(q)!; const it = (section: string, ...names: string[]) => ({ ...foldItem(...names, section), section });
  expect(m('khebez')(it('Pain Relief', 'بانادول اكسترا', 'Panadol Extra'))).toBe(false);          // French "pain" = bread, and the category is "Pain Relief"
  expect(m('khebez')(it('Bread & Bakery', 'خبز عربي', 'Arabic bread'))).toBe(true);
  expect(m('ahwe')(it('Deodorants', 'مزيل عرق', 'Deo coffee'))).toBe(false);
  expect(m('ahwe')(it('Coffee', 'بن مطحون', 'Ground coffee'))).toBe(true);
  expect(m('ahwe')(it('My Own Category', 'بن', 'Coffee beans'))).toBe(true);                       // a shop's own category is left alone
  expect(m('jebne')(it('Chips & Nuts', 'شيبس', 'Cheese chips'))).toBe(false);
  expect(m('jebne')(it('Packaged Cheese', 'عكاوي', 'Akawi cheese'))).toBe(true);
  expect(m('tandif')(it('Detergents & Disinfectants', 'ديتول', 'Dettol'))).toBe(true);            // not a food kind: the non-food list does not apply to it
  expect(m('panadol')(it('Pain Relief', 'بانادول اكسترا', 'Panadol Extra'))).toBe(true);
  expect(m('cheese chips')(it('Chips & Nuts', 'شيبس', 'Cheese chips'))).toBe(true);                // the word itself is in the name
  expect(m('khebez')(foldItem('خبز', 'bread'))).toBe(true);                                        // no category known: as before
});

test('hookah kind (122): every spelling finds the pipe, its tobacco and its charcoal; not cigarettes, not food', () => {
  const m = (q: string) => makeMatcher(q)!;
  for (const q of ['argile', 'arguile', 'nargile', 'shisha', 'أرغيلة', 'أركيلة', 'نرجيلة']) {
    expect(m(q)(foldItem('أركيلة تفاحتين (راس واحد)', 'Argile 2 apples (1 head)', 'Argile')), q).toBe(true);
    expect(m(q)(foldItem('معسل فاخر تفاحتين', 'Tobacco Al Fakher 2 apples', 'Argile Tobacco (Maassel)')), q).toBe(true);
    expect(m(q)(foldItem('يحيى قصدير أركيلة مثقب', 'Yahya Perforated Argile Foil', 'Argile')), q).toBe(true);
    expect(m(q)(foldItem('راس أرغيلة فخار', 'RAS ARGUILE FAKHAR', 'Tobacco')), q).toBe(true);
    expect(m(q)(foldItem('مارلبورو أحمر', 'Marlboro Red', 'Tobacco')), q).toBe(false);
    expect(m(q)(foldItem('بيبسي', 'Pepsi', 'Soft Drinks')), q).toBe(false);
  }
});

test('the categories a kind never matches in are the same in the till and in the database (97)', async () => {
  const { readFileSync } = await import('node:fs');
  const { CONCEPTS, notInOf } = await import('./concepts');
  const sql = ['97_kind_not_in_category.sql', '122_hookah_kind.sql'].map(f => readFileSync(new URL(`../../../supabase/schema/${f}`, import.meta.url), 'utf8')).join('\n');
  const lit = (a: string[]) => `array[${a.map(x => `'${x.replace(/'/g, "''")}'`).join(', ')}]::text[]`;
  for (const c of CONCEPTS) expect(sql.includes(`update suqa.match_concepts set not_in = ${lit(notInOf(c))} where id = '${c.id}';`), c.id).toBe(true);
});

describe('searchItems (the shop page search box)', () => {
  const mk = (ar: string, en: string, sec: string, secAr = '', aliases: string[] = []) => ({ ar, en, f: foldForSearch([ar, en, ...aliases], [sec, secAr], sec) });
  const shop = [
    mk('بانتين شامبو', 'Pantene shampoo', 'Hair Care', 'العناية بالشعر'),
    mk('بانتين بلسم', 'Pantene conditioner', 'Hair Care', 'العناية بالشعر'),
    mk('زيت زيتون', 'Olive oil', 'Pantry (Mouneh)', 'مونة', ['zeit', 'zet']),
    mk('زعتر', 'Zaatar', 'Pantry (Mouneh)', 'مونة'),
    mk('ماستر نتس فستق مقلي 20 غ', 'MASTER NUTS PEANUT FRIED 20GR', 'Chips & Nuts', 'تشيبس ومكسرات'),
    mk('كركيش بوبس', 'KARKESH POPS', 'Chips & Nuts', 'تشيبس ومكسرات'),
    mk('بيبسي 2 ل', 'Pepsi 2L', 'Soft Drinks', 'مشروبات غازية'),
    mk('صحن طاووق', 'Taouk platter', 'Platters', 'صحون'),
    mk('خبز عربي', 'Arabic bread', 'Bread & Bakery', 'خبز'),
  ];
  const find = (q: string) => searchItems(shop, x => x.f, q).map(x => x.en);
  it('a brand typed in either alphabet gives that brand only — not a category that sounds like it, not a word one sound away', () => {
    expect(find('panten')).toEqual(['Pantene shampoo', 'Pantene conditioner']);
    expect(find('pantene')).toEqual(['Pantene shampoo', 'Pantene conditioner']);
    expect(find('بانتين')).toEqual(['Pantene shampoo', 'Pantene conditioner']);
    expect(find('panten shampa')).toEqual(['Pantene shampoo']);
  });
  it('"pepsi" is not "pops", in Latin or in Arabic letters', () => {
    expect(find('pepsi')).toEqual(['Pepsi 2L']);
    expect(find('bebsi')).toEqual(['Pepsi 2L']);
    expect(find('بيبسي')).toEqual(['Pepsi 2L']);
    expect(find('pops')).toEqual(['KARKESH POPS']);
  });
  it('Arabizi still finds the Arabic name; a category name still filters when typed as written', () => {
    expect(find('tawouk')).toEqual(['Taouk platter']);
    expect(find('khebez')).toEqual(['Arabic bread']);
    expect(find('zet')).toEqual(['Olive oil']);
    expect(find('pantry')).toEqual(['Olive oil', 'Zaatar']);
    expect(find('مونة')).toEqual(['Olive oil', 'Zaatar']);
  });
  it('a typo is forgiven only when nothing matched as typed or by sound; nothing for nonsense; everything for an empty box', () => {
    expect(find('pantine')).toEqual(['Pantene shampoo', 'Pantene conditioner']);
    expect(find('zzzz')).toEqual([]);
    expect(find('  ')).toHaveLength(shop.length);
  });
  it('a kind word next to a brand ("rico rice"): that brand, that kind — not the whole brand', () => {
    const sec = 'Grains, Pulses & Spices', secAr = 'حبوب وبقول وبهارات';
    const rico = [mk('ريكو رز أميركي 1 كغ', 'RICO AMERICAN RICE 1 KG.', sec, secAr), mk('ريكو رز مصري 1 كغ', 'RICO EGIPTIAN RICE 1 KG.', sec, secAr),
      mk('ريكو قرفة 100 غ', 'RICO CINNAMON 100 G.', sec, secAr), mk('ريكو خميرة 50 غ', 'RICO YEAST 50 G.', sec, secAr), mk('تاج دايموند رز بسمتي 900 غ', 'TAJ DIAMOND BASMATI RICE 900GR', sec, secAr)];
    const f = (q: string) => searchItems(rico, x => x.f, q).map(x => x.en);
    expect(f('rico rice')).toEqual(['RICO AMERICAN RICE 1 KG.', 'RICO EGIPTIAN RICE 1 KG.']);
    expect(f('rico rez')).toEqual(['RICO AMERICAN RICE 1 KG.', 'RICO EGIPTIAN RICE 1 KG.']);
    expect(f('ريكو رز')).toEqual(['RICO AMERICAN RICE 1 KG.', 'RICO EGIPTIAN RICE 1 KG.']);
    expect(f('rico')).toHaveLength(4);
    expect(f('rice').slice(0, 3)).toEqual(['RICO AMERICAN RICE 1 KG.', 'RICO EGIPTIAN RICE 1 KG.', 'TAJ DIAMOND BASMATI RICE 900GR']);   // the word as typed first; the brand that sounds like it after
  });
});
