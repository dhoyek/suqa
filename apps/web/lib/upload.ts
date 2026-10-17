'use client';
import type { SuqaClient } from '@suqa/shared';

const BUCKET = 'media';
const MAX_EDGE = 1200;

/** Downscale + re-encode in the browser so uploads stay small on Lebanese mobile data. */
export async function compressImage(file: File, maxEdge = MAX_EDGE, quality = 0.82): Promise<Blob> {
  const bitmap = await createImageBitmap(file).catch(() => null);
  if (!bitmap) return file;
  const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
  const w = Math.round(bitmap.width * scale), h = Math.round(bitmap.height * scale);
  const canvas = document.createElement('canvas'); canvas.width = w; canvas.height = h;
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, w, h);
  const blob: Blob | null = await new Promise(res => canvas.toBlob(res, 'image/jpeg', quality));
  return blob ?? file;
}

/** Uploads to media/shops/<shopId>/<kind>-<ts>.jpg and returns the public URL. */
export async function uploadShopImage(sb: SuqaClient, shopId: string, kind: 'logo' | 'cover' | 'product', file: File): Promise<string> {
  const blob = await compressImage(file, kind === 'cover' ? 1600 : kind === 'logo' ? 512 : MAX_EDGE);
  const path = `shops/${shopId}/${kind}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.jpg`;
  const { error } = await sb.storage.from(BUCKET).upload(path, blob, { contentType: 'image/jpeg', cacheControl: '31536000', upsert: false });
  if (error) throw error;
  return sb.storage.from(BUCKET).getPublicUrl(path).data.publicUrl;
}

/** Best-effort delete of a previously uploaded file (by its public URL). */
export async function deleteShopImage(sb: SuqaClient, url: string | null | undefined) {
  if (!url) return;
  const i = url.indexOf(`/object/public/${BUCKET}/`);
  if (i < 0) return;
  await sb.storage.from(BUCKET).remove([decodeURIComponent(url.slice(i + `/object/public/${BUCKET}/`.length))]).catch(() => {});
}
