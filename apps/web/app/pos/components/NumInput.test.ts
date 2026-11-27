import { describe, expect, it } from 'vitest';
import { toNumText } from './NumInput';

describe('number box text', () => {
  it('keeps a decimal while it is being typed, and reads a comma and Arabic digits', () => {
    expect(toNumText('1.')).toBe('1.'); expect(toNumText('1.5')).toBe('1.5'); expect(toNumText('.5')).toBe('.5');
    expect(toNumText('1,25')).toBe('1.25'); expect(toNumText('١٢٫٥')).toBe('12.5'); expect(toNumText('12abc')).toBe('12');
    expect(toNumText('1.2.3')).toBe('1.2'); expect(toNumText('-4')).toBe('4'); expect(toNumText('')).toBe('');
  });
});
