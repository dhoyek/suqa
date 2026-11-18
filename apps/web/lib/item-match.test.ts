import { expect, test } from 'vitest';
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
});
