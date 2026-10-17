import { describe, it, expect } from 'vitest';
import { safeNext } from '../safe-next';

describe('safeNext (open-redirect guard)', () => {
  it('keeps same-site paths', () => { expect(safeNext('/orders')).toBe('/orders'); expect(safeNext('/s/abou-elie?x=1')).toBe('/s/abou-elie?x=1'); });
  it('falls back on anything that could leave the site', () => {
    for (const bad of ['https://evil.example', '//evil.example/x', '/\\evil.example', 'javascript:alert(1)', '/a\nLocation: x', '', undefined, null]) {
      expect(safeNext(bad as any, '/shop')).toBe('/shop');
    }
  });
});
