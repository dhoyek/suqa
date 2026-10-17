import { describe, it, expect } from 'vitest';
import { t, RTL } from '../i18n';

describe('i18n t()', () => {
  it('picks the locale, then the fallback, then anything', () => {
    expect(t({ ar: 'خبز', en: 'Bread' }, 'ar')).toBe('خبز');
    expect(t({ en: 'Bread' }, 'ar')).toBe('Bread');
    expect(t({ fr: 'Pain' } as any, 'ar')).toBe('Pain');
    expect(t(null, 'ar')).toBe('');
  });
  it('marks Arabic as RTL only', () => { expect(RTL.ar).toBe(true); expect(RTL.en).toBe(false); });
});
