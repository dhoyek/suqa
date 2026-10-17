/** Decode a PostGIS point as returned by PostgREST (EWKB hex, e.g. "0101000020E6100000<x><y>") into {lat,lng}. */
export function pointFromEwkb(hex: unknown): { lat: number; lng: number } | null {
  if (typeof hex !== 'string' || hex.length < 50) return null;
  try {
    const bytes = new Uint8Array(hex.match(/.{2}/g)!.map(h => parseInt(h, 16)));
    const dv = new DataView(bytes.buffer);
    const little = bytes[0] === 1;
    const type = dv.getUint32(1, little);
    const hasSrid = (type & 0x20000000) !== 0;
    const off = 5 + (hasSrid ? 4 : 0);
    if ((type & 0xff) !== 1) return null; // not a Point
    return { lng: dv.getFloat64(off, little), lat: dv.getFloat64(off + 8, little) };
  } catch { return null; }
}

/** EWKT literal accepted by PostgREST for geography columns and RPC args. */
export const pointToEwkt = (p: { lat: number; lng: number }) => `SRID=4326;POINT(${p.lng} ${p.lat})`;
