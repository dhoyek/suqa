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
