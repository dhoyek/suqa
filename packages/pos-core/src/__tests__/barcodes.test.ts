import { describe, it, expect } from 'vitest';

describe('barcode variants (legacy data without check digits)', () => {
  it('matches a camera-read EAN-13 against a stored 12-digit code', async () => {
    const { barcodeVariants, gtinCheckDigit } = await import('../catalog');
    expect(gtinCheckDigit('400638133393')).toBe(1);               // 4006381333931 (Stabilo) → check digit 1
    expect(barcodeVariants('4006381333931')).toContain('400638133393');
    expect(barcodeVariants('528500069008')).toContain('5285000690087');   // stored stripped → full symbol
    expect(barcodeVariants('012345678905')).toContain('0012345678905');  // UPC-A → EAN-13 spelling
    expect(barcodeVariants('ICEBER')).toEqual(['ICEBER']);
  });
});
