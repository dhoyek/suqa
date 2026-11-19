import { expect, test } from 'vitest';
import { CatalogIndex } from './catalog';
import { foldItem, makeMatcher, skelWords } from './item-match';
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
  const sql = readFileSync(new URL('../../../supabase/schema/84_category_matching.sql', import.meta.url), 'utf8');
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
