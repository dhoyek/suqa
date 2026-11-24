// An item photo, tidied on the device before it is uploaded: cropped to the square the shop page shows, and its light evened
// out (a dim shop shelf, a grey cast). No AI, no network, no cost: it runs on a canvas in the browser, so it works offline.
// It never invents anything: every pixel is the photo's own, only brighter or darker.

/** The stretch for one photo, from its brightness spread: darkest 1% → black point, brightest 1% → white point, and a gentle
 *  lift of the middle when the photo is dark overall. Limits keep a photo that is already fine untouched and stop a nearly
 *  flat photo (a white wall) from being blown up into noise. */
export function levelsOf(lum: Uint32Array | number[], total: number): { lo: number; hi: number; gamma: number } {
  const at = (frac: number) => { let acc = 0; for (let i = 0; i < 256; i++) { acc += lum[i]; if (acc >= total * frac) return i; } return 255; };
  let lo = at(0.01), hi = at(0.99); const mid = at(0.5);
  if (hi - lo < 64) return { lo: 0, hi: 255, gamma: 1 };                  // nearly one tone (a wall, a blank label): leave it
  lo = Math.min(lo, 60); hi = Math.max(hi, 180);                         // never stretch by more than these: a dark photo is lifted, not burnt
  const m = Math.min(0.98, Math.max(0.02, (mid - lo) / (hi - lo)));     // where the middle lands after the stretch
  const gamma = m < 0.45 ? Math.max(0.65, Math.log(0.5) / Math.log(m)) : 1;      // dark overall → lift the middle towards half; < 1 brightens
  return { lo, hi, gamma: Math.min(1, gamma) };
}
/** the 0–255 lookup table of that stretch */
export function levelsTable(l: { lo: number; hi: number; gamma: number }): Uint8ClampedArray {
  const t = new Uint8ClampedArray(256);
  for (let i = 0; i < 256; i++) t[i] = Math.round(255 * Math.pow(Math.min(1, Math.max(0, (i - l.lo) / (l.hi - l.lo))), l.gamma));
  return t;
}

/** file → a square JPEG (centre crop, at most `edge` px) with its light evened out. Falls back to the file itself if the
 *  browser cannot decode it. */
export async function tidyItemPhoto(file: Blob, edge = 1200, quality = 0.85): Promise<Blob> {
  const bitmap = await createImageBitmap(file).catch(() => null);
  if (!bitmap) return file;
  const side = Math.min(bitmap.width, bitmap.height); const out = Math.min(edge, side);
  const canvas = document.createElement('canvas'); canvas.width = out; canvas.height = out;
  const ctx = canvas.getContext('2d', { willReadFrequently: true }); if (!ctx) return file;
  ctx.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, out, out);
  const img = ctx.getImageData(0, 0, out, out); const d = img.data; const hist = new Uint32Array(256);
  for (let i = 0; i < d.length; i += 4) hist[(d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) >> 8]++;
  const t = levelsTable(levelsOf(hist, out * out));
  for (let i = 0; i < d.length; i += 4) { d[i] = t[d[i]]; d[i + 1] = t[d[i + 1]]; d[i + 2] = t[d[i + 2]]; }
  ctx.putImageData(img, 0, 0);
  const blob: Blob | null = await new Promise(res => canvas.toBlob(res, 'image/jpeg', quality));
  return blob ?? file;
}
