import { describe, it, expect } from 'vitest';
import { pointFromEwkb, pointToEwkt } from '../geo';

// EWKB for SRID=4326;POINT(35.6581 34.2553) as PostGIS/PostgREST returns it (little-endian, with SRID flag)
const HEX = '0101000020E6100000' + le(35.6581) + le(34.2553);
function le(v: number) { const b = Buffer.alloc(8); b.writeDoubleLE(v); return b.toString('hex').toUpperCase(); }

describe('geo', () => {
  it('decodes EWKB hex points', () => {
    const p = pointFromEwkb(HEX)!;
    expect(p.lng).toBeCloseTo(35.6581, 6);
    expect(p.lat).toBeCloseTo(34.2553, 6);
  });
  it('returns null for junk', () => {
    expect(pointFromEwkb(null)).toBeNull();
    expect(pointFromEwkb('zz')).toBeNull();
    expect(pointFromEwkb({ not: 'hex' })).toBeNull();
  });
  it('encodes EWKT in lng/lat order', () => { expect(pointToEwkt({ lat: 34.2553, lng: 35.6581 })).toBe('SRID=4326;POINT(35.6581 34.2553)'); });
});
